import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { shouldUseShellForCommand } from "@/shared/services/cliRuntime";

/**
 * Minimal Agent Client Protocol (https://agentclientprotocol.com) client: newline
 * delimited JSON-RPC 2.0 over the stdio of a spawned agent. It carries the client
 * side of one session and answers the agent's own requests under a deny-by-default
 * policy: the agent is a text backend here, never a tool host for the gateway.
 */

export type AcpPermissionPolicy = "reject" | "allow";

type JsonRecord = Record<string, unknown>;

/** JSON-RPC error code used for requests the client refuses by policy. */
export const ACP_DENIED_CODE = -32000;
const METHOD_NOT_FOUND = -32601;
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;
const KILL_ESCALATION_MS = 2000;

/** Agent stderr is untrusted text: mask token-looking runs before it can reach an error body. */
function maskCredentialLikeText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|pk|ghp|gho|xox[abps]|AIza)[-_A-Za-z0-9]{12,}/g, "[REDACTED]");
}

/**
 * Environment variables a spawned agent inherits from the gateway. Everything else
 * (session secrets, provider keys, database settings) stays out of the child, which
 * runs model-driven tools. Agent-specific names come in through `passEnv`.
 */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TZ",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function buildAcpChildEnv(
  extra: Record<string, string | undefined> = {},
  passEnv: string[] = [],
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...INHERITED_ENV, ...passEnv]) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

export type AcpSessionUpdate = JsonRecord & { sessionUpdate?: string };

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Default timeout for one request, ms. A request may override it; 0 disables it. */
  requestTimeoutMs?: number;
  permissionPolicy?: AcpPermissionPolicy;
  onUpdate?: (update: AcpSessionUpdate) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Outcome for `session/request_permission` under the given policy. */
export function decidePermission(params: unknown, policy: AcpPermissionPolicy): JsonRecord {
  const options = Array.isArray(asRecord(params).options)
    ? (asRecord(params).options as unknown[]).map(asRecord)
    : [];
  const wanted = policy === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const match = options.find(
      (option) => option.kind === kind && typeof option.optionId === "string"
    );
    if (match) return { outcome: { outcome: "selected", optionId: match.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

export class AcpClient {
  private readonly options: AcpClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail = "";
  // Multi-byte characters can straddle two chunks; a decoder per stream keeps them whole.
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private exitInfo?: string;
  private spawnError?: Error;
  private exitPromise?: Promise<void>;

  constructor(options: AcpClientOptions) {
    this.options = options;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get exited(): boolean {
    return this.exitInfo !== undefined;
  }

  /** Last bytes the agent wrote to stderr (unscrubbed; callers sanitize before surfacing). */
  get stderr(): string {
    return this.stderrTail.trim();
  }

  start(): void {
    if (this.child) throw new Error("ACP client already started");
    const { command, args = [], cwd, env } = this.options;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: shouldUseShellForCommand(command),
      windowsHide: true,
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = signal ? `signal ${signal}` : `code ${code}`;
        this.failAll(this.exitError());
        resolveExit();
      });
      child.once("error", (error) => {
        // spawn failure (ENOENT, EACCES): no exit event follows
        this.spawnError = error;
        this.exitInfo = `spawn error ${(error as NodeJS.ErrnoException).code ?? ""}`.trim();
        this.failAll(error);
        resolveExit();
      });
    });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + this.stderrDecoder.write(chunk)).slice(
        -STDERR_TAIL_BYTES
      );
    });
    // A write to a dead agent raises EPIPE on the stream; the exit handler reports it.
    child.stdin.on("error", () => undefined);
  }

  private exitError(): Error {
    const tail = this.stderr ? `: ${maskCredentialLikeText(this.stderr.slice(-400))}` : "";
    return new Error(`ACP agent exited (${this.exitInfo})${tail}`);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += this.stdoutDecoder.write(chunk);
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.failAll(new Error("ACP agent produced an oversized message"));
      this.kill();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return; // agents may print banners or logs on stdout; only JSON objects matter
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === "string") {
      if (hasId) this.onAgentRequest(message.id as number | string, message.method, message.params);
      else this.onNotification(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const entry = this.pending.get(message.id as number);
    if (!entry) return;
    this.pending.delete(message.id as number);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const err = asRecord(message.error);
      entry.reject(
        new AcpRpcError(
          typeof err.code === "number" ? err.code : -32603,
          typeof err.message === "string" ? err.message : "ACP agent returned an error",
          err.data
        )
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const update = asRecord(asRecord(params).update);
    try {
      this.options.onUpdate?.(update as AcpSessionUpdate);
    } catch {
      // a faulty consumer must not break the protocol loop
    }
  }

  private onAgentRequest(id: number | string, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      this.write({
        id,
        result: decidePermission(params, this.options.permissionPolicy ?? "reject"),
      });
      return;
    }
    if (method.startsWith("fs/") || method.startsWith("terminal/")) {
      this.write({ id, error: { code: ACP_DENIED_CODE, message: "Denied by gateway policy" } });
      return;
    }
    this.write({ id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
  }

  private write(message: JsonRecord): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000
  ): Promise<unknown> {
    if (this.spawnError) return Promise.reject(this.spawnError);
    if (this.exited) return Promise.reject(this.exitError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** Resolves when the agent process has exited or failed to spawn. */
  whenExited(): Promise<void> {
    return this.exitPromise ?? Promise.resolve();
  }

  /** SIGTERM is followed by SIGKILL after a short delay, so an agent that ignores it cannot leak. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child || this.exited) return;
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
    if (signal === "SIGTERM") {
      const forced = setTimeout(() => this.kill("SIGKILL"), KILL_ESCALATION_MS);
      forced.unref?.();
      void this.whenExited().then(() => clearTimeout(forced));
    }
  }

  /** Close stdin, ask the agent to stop, escalate to SIGKILL, and wait for the exit. */
  async close(graceMs = 1000): Promise<void> {
    if (!this.child) return;
    this.failAll(new Error("ACP client closed"));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    if (!this.exited) {
      this.kill("SIGTERM");
      const forced = setTimeout(() => this.kill("SIGKILL"), graceMs);
      forced.unref?.();
      await this.whenExited();
      clearTimeout(forced);
    }
  }
}
