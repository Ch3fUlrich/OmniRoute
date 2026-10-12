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

/** What an injected token is replaced with in agent output. */
export const ACP_REDACTED = "[redacted]";

/** Shorter values are almost certainly ordinary text, not a credential. */
const MIN_MASKED_VALUE_LENGTH = 8;

function maskExactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) out = out.split(value).join(ACP_REDACTED);
  return out;
}

/** One piece of masked stream text with the kind (content/reasoning) it arrived under. */
export type AcpMaskedPiece = { kind: string; text: string };

/**
 * Masks the literal token values the executor injected into the agent's environment.
 * The agent's text is untrusted: an agent that prints its own token must not deliver
 * it. Matching is exact-substring only — no pattern guessing. `feed()` tags each piece
 * with the kind it arrived under and holds back the longest possible partial match,
 * with one pending buffer over the whole turn, so a value split across two chunks —
 * even chunks of different kinds — is masked instead of delivered in halves. A
 * completed match is emitted under the kind of its first piece, keeping the order of
 * everything else. `flush()` releases what is still withheld once the turn is over.
 */
export class AcpTextMasker {
  private readonly values: string[];
  private readonly longest: number;
  private readonly firstChars: Set<string>;
  private pending = "";
  /** Kind per buffered character, so withheld text is emitted under its own kind. */
  private pendingKinds: string[] = [];

  constructor(values: readonly (string | undefined)[]) {
    this.values = [...new Set(values.filter(hasLength))].sort((a, b) => b.length - a.length);
    this.longest = this.values.length ? this.values[0].length : 0;
    this.firstChars = new Set(this.values.map((value) => value.slice(0, 1)));
  }

  /** Mask a whole string at once (error messages, log lines). */
  mask(text: string): string {
    if (!this.values.length) return text;
    return maskExactValues(text, this.values);
  }

  /**
   * Mask one streamed piece of kind `kind`. Every match inside the accumulated turn
   * text is replaced, and only the suffix that could still grow into a match is
   * withheld, regardless of the kinds the withheld characters arrived under.
   */
  feed(text: string, kind: string): AcpMaskedPiece[] {
    if (!this.values.length) return text ? [{ kind, text }] : [];
    const acc = this.pending + text;
    const kinds = this.pendingKinds.concat(new Array(text.length).fill(kind));
    return this.scan(acc, kinds, false);
  }

  /** Mask and release whatever is still withheld; nothing can complete the match now. */
  flush(): AcpMaskedPiece[] {
    const acc = this.pending;
    const kinds = this.pendingKinds;
    this.pending = "";
    this.pendingKinds = [];
    if (!this.values.length || !acc) return [];
    return this.scan(acc, kinds, true);
  }

  private scan(acc: string, kinds: string[], final: boolean): AcpMaskedPiece[] {
    const pieces: AcpMaskedPiece[] = [];
    let buf = "";
    let bufKind = "";
    let i = 0;
    while (i < acc.length) {
      if (buf && bufKind !== kinds[i]) {
        pieces.push({ kind: bufKind, text: buf });
        buf = "";
      }
      bufKind = kinds[i];
      const match = this.matchAt(acc, i);
      if (match) {
        buf += ACP_REDACTED;
        i += match.length;
        continue;
      }
      if (!final && this.firstChars.has(acc[i]) && this.isProperPrefixOfValue(acc, i)) break;
      buf += acc[i];
      i += 1;
    }
    if (i < acc.length) {
      this.pending = acc.slice(i);
      this.pendingKinds = kinds.slice(i);
    } else {
      this.pending = "";
      this.pendingKinds = [];
    }
    if (buf) pieces.push({ kind: bufKind, text: buf });
    return pieces;
  }

  /** The longest value starting at `index`, if any (values are sorted longest-first). */
  private matchAt(acc: string, index: number): string | undefined {
    for (const value of this.values) {
      if (acc.startsWith(value, index)) return value;
    }
    return undefined;
  }

  /** True when the remainder from `index` could still grow into a whole value. */
  private isProperPrefixOfValue(acc: string, index: number): boolean {
    const rest = acc.slice(index);
    return rest.length < this.longest && this.values.some((value) => value.startsWith(rest));
  }
}

function hasLength(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_MASKED_VALUE_LENGTH;
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
  /** Exact values (the token injected into the agent env) masked wherever the agent repeats them. */
  secrets?: readonly (string | undefined)[];
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
  private readonly secretMasker: AcpTextMasker;
  private exitInfo?: string;
  private spawnError?: Error;
  private exitPromise?: Promise<void>;

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.secretMasker = new AcpTextMasker(options.secrets ?? []);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get exited(): boolean {
    return this.exitInfo !== undefined;
  }

  /**
   * Last bytes the agent wrote to stderr, with the injected token masked out. Still
   * unscrubbed for anything else it may print: callers sanitize before surfacing.
   */
  get stderr(): string {
    return this.secretMasker.mask(this.stderrTail).trim();
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
          typeof err.message === "string"
            ? this.secretMasker.mask(err.message)
            : "ACP agent returned an error",
          this.maskErrorData(err.data)
        )
      );
    } else {
      entry.resolve(message.result);
    }
  }

  /**
   * An agent-supplied `error.data` is untrusted text: mask the injected token in it
   * (string leaves via a JSON round trip; anything unserializable degrades to a
   * masked string) so no caller can surface the key from the stored error.
   */
  private maskErrorData(data: unknown): unknown {
    if (typeof data === "string") return this.secretMasker.mask(data);
    if (data === null || data === undefined || typeof data !== "object") return data;
    try {
      return JSON.parse(this.secretMasker.mask(JSON.stringify(data)));
    } catch {
      return this.secretMasker.mask(String(data));
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
