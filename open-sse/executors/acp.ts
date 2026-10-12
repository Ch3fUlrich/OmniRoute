import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { getAcpAgent, type AcpAgentSpec } from "./acpAgents.ts";
import {
  AcpClient,
  AcpRpcError,
  AcpTextMasker,
  buildAcpChildEnv,
  type AcpPermissionPolicy,
  type AcpSessionUpdate,
} from "./acpProtocol.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";

/**
 * Generic Agent Client Protocol executor. It starts a local coding agent that speaks
 * ACP on stdio (see acpAgents.ts), runs one chat turn in a fresh session, and maps
 * the agent's streamed `session/update` chunks onto an OpenAI chat completion.
 *
 * The agent is used as a text backend: it starts in an empty scratch directory,
 * advertises no fs/terminal capability, gets a minimal environment, and every
 * permission request is rejected unless the operator opts in.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type OpenAIMsg = { role?: string; content?: unknown };

export interface AcpExecutorOptions {
  /** Override the agent binary (tests, custom install paths). */
  command?: string;
  /** Override the agent arguments. */
  args?: string[];
  /** Extra environment for the agent, on top of the minimal inherited set. */
  env?: Record<string, string>;
  /** Working directory for the agent. Default: a fresh empty temp dir per turn. */
  cwd?: string;
  permissionPolicy?: AcpPermissionPolicy;
  /** Session mode to request (e.g. one that refuses tools); skipped if the agent lacks it. */
  sessionMode?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  cancelGraceMs?: number;
  maxConcurrent?: number;
  /** Cap on text collected per turn; the turn is cancelled past it and ends as `length`. */
  maxOutputBytes?: number;
}

const activeTurns = new Map<string, number>();

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (record.type === "text" || record.type === "input_text" || record.type === "output_text") {
        return typeof record.text === "string" ? record.text : "";
      }
      return "";
    })
    .join("");
}

/** Flatten an OpenAI conversation into the single text prompt of one ACP turn. */
export function buildAcpPrompt(messages: OpenAIMsg[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const text = textFromContent(message.content).trim();
    if (!text) continue;
    const role = String(message.role || "user");
    const label = role === "system" ? "System" : role === "assistant" ? "Assistant" : "User";
    parts.push(`[${label}]\n${text}`);
  }
  return parts.join("\n\n") || "(empty)";
}

function finishReasonFor(stopReason: unknown): string {
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated?: true;
};

function numberOf(...values: unknown[]): number {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function usageFrom(result: JsonRecord, prompt: string, content: string): Usage {
  const reported = asRecord(result.usage);
  const input = numberOf(reported.inputTokens, reported.input_tokens);
  const output = numberOf(reported.outputTokens, reported.output_tokens);
  const total = numberOf(reported.totalTokens, reported.total_tokens, input + output);
  if (input > 0 || output > 0 || total > 0) {
    return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
  }
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(content);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function abortError(): Error {
  const error = new Error("ACP request aborted");
  error.name = "AbortError";
  return error;
}

class TurnTimeoutError extends Error {}

function failureStatus(error: unknown): number {
  if (error instanceof TurnTimeoutError) return 504;
  if (
    error instanceof AcpRpcError &&
    error.code === -32000 &&
    /auth|login|credential|unauthori[sz]ed/i.test(error.message)
  )
    return 401;
  if (error instanceof Error && /timed out/i.test(error.message)) return 504;
  return 502;
}

function failureMessage(
  error: unknown,
  agent: AcpAgentSpec,
  mask?: (text: string) => string
): string {
  const message = describeFailure(error, agent);
  return mask ? mask(message) : message;
}

function describeFailure(error: unknown, agent: AcpAgentSpec): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") {
      return `ACP agent binary for ${agent.displayName} was not found or is not executable; install it or set ${agent.binEnv}.`;
    }
    return sanitizeErrorMessage(error.message);
  }
  return sanitizeErrorMessage(String(error));
}

type Outcome = { ok: true; result: JsonRecord } | { ok: false; error: unknown };

/** One ACP session: owns the agent process, the scratch directory and the concurrency slot. */
class AcpTurn {
  content = "";
  reasoning = "";
  sawOutput = false;
  aborted = false;
  private outputBytes = 0;
  private truncated = false;
  /** Called with each content/reasoning delta as it arrives. */
  emit?: (delta: JsonRecord) => void;
  /** Called once, when the first delta arrives. */
  onFirstOutput?: () => void;

  private readonly client: AcpClient;
  /** The literal token values this turn injected into the agent's environment. */
  private readonly tokenValues: string[];
  private readonly contentMasker: AcpTextMasker;
  private readonly reasoningMasker: AcpTextMasker;
  private sessionId?: string;
  private promptInFlight = false;
  private timedOut = false;
  private cleanedUp = false;
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    private readonly agent: AcpAgentSpec,
    private readonly options: AcpExecutorOptions,
    private readonly input: ExecuteInput,
    private readonly cwd: string,
    private readonly scratch: string | undefined,
    private readonly cancelGraceMs: number,
    private readonly requestTimeoutMs: number
  ) {
    this.tokenValues =
      agent.tokenEnv && input.credentials?.apiKey ? [String(input.credentials.apiKey)] : [];
    this.contentMasker = new AcpTextMasker(this.tokenValues);
    this.reasoningMasker = new AcpTextMasker(this.tokenValues);
    this.client = new AcpClient({
      command: options.command ?? process.env[agent.binEnv] ?? agent.command,
      args: options.args ?? agent.args,
      cwd,
      env: buildAcpChildEnv(
        {
          ...(agent.tokenEnv && input.credentials?.apiKey
            ? { [agent.tokenEnv]: String(input.credentials.apiKey) }
            : {}),
          ...options.env,
        },
        agent.passEnv
      ),
      requestTimeoutMs,
      permissionPolicy:
        options.permissionPolicy ??
        (process.env.ACP_PERMISSION_POLICY === "allow" ? "allow" : "reject"),
      secrets: this.tokenValues,
      onUpdate: (update) => this.onUpdate(update),
    });
    input.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  get wasTimedOut(): boolean {
    return this.timedOut;
  }

  private readonly onAbort = () => {
    this.aborted = true;
    this.cancel();
  };

  private onUpdate(update: AcpSessionUpdate): void {
    const kind = update.sessionUpdate;
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return;
    const block = asRecord(update.content);
    if (block.type !== "text" || typeof block.text !== "string" || !block.text) return;
    if (this.truncated) return;
    this.outputBytes += Buffer.byteLength(block.text);
    const limit =
      this.options.maxOutputBytes ?? envNumber("ACP_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);
    if (this.outputBytes > limit) {
      this.truncated = true;
      this.cancel();
      return;
    }
    const thought = kind === "agent_thought_chunk";
    // An agent can echo its token back across two chunks, so a piece of the delta is
    // withheld until it can no longer be part of the token.
    const text = (thought ? this.reasoningMasker : this.contentMasker).feed(block.text);
    this.sawOutput = true;
    this.onFirstOutput?.();
    if (!text) return;
    if (thought) this.reasoning += text;
    else this.content += text;
    this.emit?.(thought ? { reasoning_content: text } : { content: text });
  }

  /** Deliver the text the maskers withheld; call once the turn has settled. */
  finish(): void {
    const content = this.contentMasker.flush();
    if (content) {
      this.content += content;
      this.sawOutput = true;
      this.emit?.({ content });
    }
    const reasoning = this.reasoningMasker.flush();
    if (reasoning) {
      this.reasoning += reasoning;
      this.sawOutput = true;
      this.emit?.({ reasoning_content: reasoning });
    }
  }

  /** Mask the token in a whole string (failure text of this turn, log lines). */
  maskText(text: string): string {
    return this.contentMasker.mask(text);
  }

  /** Ask the agent to stop the turn; force-kill it if it does not within the grace period. */
  cancel(): void {
    if (this.promptInFlight && this.sessionId && !this.client.exited) {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
      const forced = setTimeout(() => this.client.kill(), this.cancelGraceMs);
      forced.unref?.();
      this.timers.push(forced);
    } else {
      this.client.kill();
    }
  }

  /**
   * Spawn the agent and prepare the session. Resolves to the model that will answer,
   * or to a refusal (`unknownModel`) when the agent does not offer the requested one.
   */
  async open(requested: string): Promise<{ model: string } | { unknownModel: string }> {
    if (this.input.signal?.aborted) {
      this.onAbort();
      throw abortError();
    }
    if (
      this.options.permissionPolicy === "allow" ||
      process.env.ACP_PERMISSION_POLICY === "allow"
    ) {
      this.input.log?.warn?.(
        "ACP",
        `${this.agent.id}: ACP_PERMISSION_POLICY=allow auto-approves agent tool requests for every caller`
      );
    }
    this.client.start();
    await this.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = asRecord(
      await this.client.request("session/new", { cwd: this.cwd, mcpServers: [] })
    );
    const sessionId = typeof created.sessionId === "string" ? created.sessionId : undefined;
    if (!sessionId) throw new Error("ACP agent returned no sessionId");
    this.sessionId = sessionId;

    const models = asRecord(created.models);
    const available = Array.isArray(models.availableModels)
      ? (models.availableModels as unknown[]).map((m) => String(asRecord(m).modelId))
      : [];
    let model =
      requested || (typeof models.currentModelId === "string" ? models.currentModelId : "");
    if (requested && available.length > 0) {
      if (!available.includes(requested)) {
        return {
          unknownModel: `Unknown ${this.agent.displayName} model "${requested}". Available: ${available.join(", ")}.`,
        };
      }
      if (requested !== models.currentModelId) {
        await this.client.request("session/set_model", { sessionId, modelId: requested });
      }
    }
    if (!model) model = this.agent.id;

    const wantedMode = this.options.sessionMode ?? this.agent.sessionMode;
    const modes = asRecord(created.modes);
    const modeIds = Array.isArray(modes.availableModes)
      ? (modes.availableModes as unknown[]).map((m) => asRecord(m).id)
      : [];
    if (wantedMode && modeIds.includes(wantedMode) && modes.currentModeId !== wantedMode) {
      await this.client.request("session/set_mode", { sessionId, modeId: wantedMode });
    } else if (wantedMode && !modeIds.includes(wantedMode)) {
      this.input.log?.warn?.(
        "ACP",
        `${this.agent.id}: agent does not offer session mode "${wantedMode}"; its own tool policy applies`
      );
    }
    return { model };
  }

  /** Send the prompt; the returned promise settles when the turn ends, however it ends. */
  prompt(text: string, turnTimeoutMs: number): Promise<Outcome> {
    this.promptInFlight = true;
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.cancel();
    }, turnTimeoutMs);
    timer.unref?.();
    this.timers.push(timer);
    return this.client
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, 0)
      .then(
        (result): Outcome => ({ ok: true, result: asRecord(result) }),
        (error): Outcome => ({ ok: false, error })
      )
      .finally(() => {
        this.promptInFlight = false;
        clearTimeout(timer);
      });
  }

  /** Turn a settled outcome into either a completed result or the error to report. */
  judge(outcome: Outcome): { result: JsonRecord } | { error: unknown } {
    if (outcome.ok === false) {
      return { error: this.timedOut ? new TurnTimeoutError("ACP turn timed out") : outcome.error };
    }
    if (outcome.result.stopReason === "cancelled") {
      if (this.truncated) return { result: { ...outcome.result, stopReason: "max_tokens" } };
      // An agent that cancels itself after producing text still answered; keep the text.
      if (this.sawOutput && !this.timedOut) return { result: outcome.result };
      return {
        error: this.timedOut
          ? new TurnTimeoutError(`ACP turn timed out after ${this.timeoutLabel()}`)
          : new Error("ACP turn was cancelled by the agent"),
      };
    }
    return { result: outcome.result };
  }

  private timeoutLabel(): string {
    return `${this.options.turnTimeoutMs ?? envNumber("ACP_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS)}ms`;
  }

  async dispose(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.input.signal?.removeEventListener("abort", this.onAbort);
    for (const timer of this.timers) clearTimeout(timer);
    await this.client.close().catch(() => undefined);
    if (this.scratch)
      await rm(this.scratch, { recursive: true, force: true }).catch(() => undefined);
    activeTurns.set(this.agent.id, Math.max(0, (activeTurns.get(this.agent.id) ?? 1) - 1));
  }
}

export class AcpExecutor extends BaseExecutor {
  private readonly agent: AcpAgentSpec;
  private readonly options: AcpExecutorOptions;
  private readonly url: string;

  constructor(agentId: string, options: AcpExecutorOptions = {}) {
    const agent = getAcpAgent(agentId);
    if (!agent) throw new Error(`Unknown ACP agent "${agentId}"`);
    const url = `acp://${agent.id}/stdio`;
    super(`${agent.id}-acp`, { id: `${agent.id}-acp`, baseUrl: url, format: "openai" });
    this.agent = agent;
    this.options = options;
    this.url = url;
  }

  buildUrl(): string {
    return this.url;
  }

  transformRequest(): null {
    return null;
  }

  // Credentials never travel as headers: the token reaches the agent through its env only.
  override buildHeaders(): Record<string, string> {
    return {};
  }

  private errorResult(status: number, message: string, model: string): ExecutorExecuteResult {
    return {
      response: errorResponse(status, message),
      url: this.url,
      headers: {},
      transformedBody: { model, agent: this.agent.id },
      transport: `acp-${this.agent.id}`,
    };
  }

  /**
   * @executorRecovery native
   * @executorRecoveryReason Local ACP subprocess turn: there is no upstream HTTP payload, so reasoning-enum, known-field and Gemini-budget recovery do not apply; failures map straight to status codes.
   * @executorRecoveryTest tests/unit/acp-executor.test.ts
   */
  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const agent = this.agent;
    const requested = typeof input.model === "string" ? input.model.trim() : "";
    if (requested.startsWith("-")) {
      return this.errorResult(
        400,
        `Invalid model "${requested}": must not start with "-".`,
        requested
      );
    }

    const maxConcurrent =
      this.options.maxConcurrent ?? envNumber("ACP_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
    if ((activeTurns.get(agent.id) ?? 0) >= maxConcurrent) {
      return this.errorResult(429, `Too many concurrent ${agent.displayName} sessions.`, requested);
    }
    activeTurns.set(agent.id, (activeTurns.get(agent.id) ?? 0) + 1);

    const turnTimeoutMs =
      this.options.turnTimeoutMs ?? envNumber("ACP_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS);
    const explicitCwd = this.options.cwd ?? (process.env.ACP_CWD || undefined);
    let scratch: string | undefined;
    try {
      scratch = explicitCwd ? undefined : await mkdtemp(join(tmpdir(), "omniroute-acp-"));
    } catch (error) {
      activeTurns.set(agent.id, Math.max(0, (activeTurns.get(agent.id) ?? 1) - 1));
      return this.errorResult(502, failureMessage(error, agent), requested);
    }
    const turn = new AcpTurn(
      agent,
      this.options,
      input,
      resolve(explicitCwd ?? (scratch as string)),
      scratch,
      this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      this.options.requestTimeoutMs ??
        envNumber("ACP_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS)
    );

    const messages = Array.isArray(asRecord(input.body).messages)
      ? (asRecord(input.body).messages as OpenAIMsg[])
      : [];
    const prompt = buildAcpPrompt(messages);

    const fail = async (error: unknown, model: string): Promise<ExecutorExecuteResult> => {
      const status = failureStatus(error);
      const message = failureMessage(error, agent, (text) => turn.maskText(text));
      await turn.dispose();
      if (turn.aborted || input.signal?.aborted) throw abortError();
      input.log?.warn?.("ACP", `${agent.id}: ${message}`);
      return this.errorResult(status, message, model);
    };

    let model: string;
    try {
      const opened = await turn.open(requested);
      if ("unknownModel" in opened) {
        await turn.dispose();
        return this.errorResult(400, opened.unknownModel, requested);
      }
      model = opened.model;
    } catch (error) {
      return fail(error, requested);
    }

    input.log?.info?.("ACP", `${agent.id} turn started model=${model}`);
    const meta = { model, agent: agent.id, promptLength: prompt.length };

    if (!input.stream) {
      const settled = await turn.prompt(prompt, turnTimeoutMs);
      turn.finish();
      const judged = turn.judge(settled);
      if ("error" in judged) return fail(judged.error, model);
      await turn.dispose();
      if (turn.aborted || input.signal?.aborted) throw abortError();
      return {
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-acp-${randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: turn.content,
                  ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
                },
                finish_reason: finishReasonFor(judged.result.stopReason),
              },
            ],
            usage: usageFrom(judged.result, prompt, turn.content),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        url: this.url,
        headers: {},
        transformedBody: meta,
        transport: `acp-${agent.id}`,
      };
    }

    // Streaming: relay deltas as they arrive. The response is only handed back once the
    // agent has produced output or finished, so a failure before the first token is a
    // real HTTP error (which lets combo/fallback routing react) instead of a 200 stream.
    const id = `chatcmpl-acp-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamOpen = true;
    const write = (payload: unknown) => {
      if (!streamOpen) return;
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
          )
        );
      } catch {
        streamOpen = false;
      }
    };
    const closeStream = () => {
      if (!streamOpen) return;
      streamOpen = false;
      try {
        controller.close();
      } catch {
        // already closed by the consumer
      }
    };
    const chunk = (
      delta: JsonRecord,
      finishReason: string | null = null,
      extra: JsonRecord = {}
    ) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        // The consumer is gone: stop the turn. Disposal follows when the prompt settles
        // (the agent answers `cancelled`, or the grace timer kills it).
        streamOpen = false;
        turn.cancel();
      },
    });
    write(chunk({ role: "assistant", content: "" }));
    turn.emit = (delta) => write(chunk(delta));

    const firstOutput = new Promise<void>((resolveFirst) => {
      turn.onFirstOutput = resolveFirst;
    });
    const settledPromise = turn.prompt(prompt, turnTimeoutMs);
    const first = await Promise.race([firstOutput.then(() => "output" as const), settledPromise]);
    if (first !== "output" && !turn.sawOutput) {
      const judged = turn.judge(first);
      if ("error" in judged) {
        streamOpen = false;
        void body.cancel().catch(() => undefined);
        return fail(judged.error, model);
      }
    }

    void settledPromise
      .then(async (outcome) => {
        turn.finish();
        const judged = turn.judge(outcome);
        if (turn.aborted || input.signal?.aborted) {
          closeStream();
        } else if ("error" in judged) {
          write(
            buildErrorBody(
              failureStatus(judged.error),
              failureMessage(judged.error, agent, (text) => turn.maskText(text))
            )
          );
          write("[DONE]");
          closeStream();
        } else {
          write(
            chunk({}, finishReasonFor(judged.result.stopReason), {
              usage: usageFrom(judged.result, prompt, turn.content),
            })
          );
          write("[DONE]");
          closeStream();
        }
        await turn.dispose();
      })
      .catch(() => {
        // The stream is already closed or failed; never let this tail become an unhandled rejection.
        closeStream();
        void turn.dispose().catch(() => undefined);
      });

    return {
      response: new Response(body, { status: 200, headers: SSE_HEADERS }),
      url: this.url,
      headers: {},
      transformedBody: { ...meta, buffered: false },
      transport: `acp-${agent.id}`,
    };
  }
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};
