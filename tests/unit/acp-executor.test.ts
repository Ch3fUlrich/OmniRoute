import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const fixture = join(process.cwd(), "tests/fixtures/fake-acp-agent.mjs");
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-acp-"));
process.env.DATA_DIR = TEST_DATA_DIR;

test.after(() => cleanupTempDataDir(TEST_DATA_DIR));

type Opts = Record<string, unknown>;

interface Completion {
  object: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage: Record<string, unknown>;
  error?: { message: string };
}

interface Chunk {
  object: string;
  choices?: Array<{
    delta: { role?: string; content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: Record<string, unknown>;
  error?: unknown;
}

interface LogEntry {
  method?: string;
  params: {
    protocolVersion?: number;
    clientCapabilities?: unknown;
    cwd?: string;
    mcpServers?: unknown[];
    modelId?: string;
    prompt: Array<{ type: string }>;
  };
}

async function completion(response: Response): Promise<Completion> {
  return (await response.json()) as Completion;
}

async function load() {
  return import("../../open-sse/executors/acp.ts");
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-acp-case-"));
  return { dir, log: join(dir, "log.jsonl"), pid: join(dir, "pid") };
}

function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function makeExecutor(extra: Opts = {}, env: Record<string, string> = {}, agentId = "qoder") {
  const { AcpExecutor } = await load();
  const s = scratch();
  const executor = new AcpExecutor(agentId, {
    command: process.execPath,
    args: [fixture],
    env: { FAKE_ACP_LOG: s.log, FAKE_ACP_PIDFILE: s.pid, ...env },
    requestTimeoutMs: 3000,
    turnTimeoutMs: 5000,
    cancelGraceMs: 200,
    ...extra,
  });
  return { executor, s };
}

function body(text = "say hi", extra: Opts = {}) {
  return {
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: text },
    ],
    ...extra,
  };
}

interface ExecutorLike {
  execute(input: Record<string, unknown>): Promise<unknown>;
}

function unwrap(result: unknown): Response {
  return (
    result && typeof result === "object" && "response" in result
      ? (result as { response: Response }).response
      : result
  ) as Response;
}

async function run(executor: ExecutorLike, text: string, stream: boolean, extra: Opts = {}) {
  const result = await executor.execute({
    model: "alpha",
    body: body(text),
    stream,
    credentials: {},
    ...extra,
  });
  return unwrap(result);
}

function sseEvents(text: string): Chunk[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => frame.slice(5).trim())
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

function pidAlive(pidFile: string): boolean {
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

// ── agent table ────────────────────────────────────────────────────────────────

test("ACP agent table lists qoder, qwen-code and opencode with their ACP launch args", async () => {
  const { getAcpAgent, ACP_AGENTS } = await import("../../open-sse/executors/acpAgents.ts");
  assert.deepEqual(Object.keys(ACP_AGENTS).sort(), ["opencode", "qoder", "qwen-code"]);
  assert.deepEqual(getAcpAgent("qoder")?.args, ["--acp"]);
  assert.equal(getAcpAgent("qoder")?.command, "qodercli");
  assert.deepEqual(getAcpAgent("qwen-code")?.args, ["--acp"]);
  assert.equal(getAcpAgent("qwen-code")?.command, "qwen");
  // qwen-code authenticates with the "openai" method: the connection key, not the gateway's own env.
  assert.equal(getAcpAgent("qwen-code")?.tokenEnv, "OPENAI_API_KEY");
  assert.equal(getAcpAgent("qwen-code")?.passEnv?.includes("OPENAI_API_KEY"), false);
  assert.deepEqual(getAcpAgent("opencode")?.args, ["acp"]);
  assert.equal(getAcpAgent("nope"), undefined);
});

test("ACP executor rejects an unknown agent id at construction", async () => {
  const { AcpExecutor } = await load();
  assert.throws(() => new AcpExecutor("no-such-agent"), /Unknown ACP agent/);
});

// ── prompt flattening ──────────────────────────────────────────────────────────

test("buildAcpPrompt labels roles and flattens text parts", async () => {
  const { buildAcpPrompt } = await load();
  const text = buildAcpPrompt([
    { role: "system", content: "rules" },
    {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image_url", image_url: {} },
        { type: "text", text: "b" },
      ],
    },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
    { role: "tool", content: "" },
  ]);
  assert.equal(text, "[System]\nrules\n\n[User]\nab\n\n[Assistant]\nok\n\n[User]\nnext");
  assert.equal(buildAcpPrompt([]), "(empty)");
});

// ── happy paths ────────────────────────────────────────────────────────────────

test("non-stream turn returns an OpenAI chat completion with agent usage", async () => {
  const { executor, s } = await makeExecutor();
  const response = await run(executor, "say hi", false);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const json = await completion(response);
  assert.equal(json.object, "chat.completion");
  assert.equal(json.model, "alpha");
  assert.equal(json.choices[0].message.role, "assistant");
  assert.equal(json.choices[0].message.content, "hello world");
  assert.equal(json.choices[0].message.reasoning_content, "thinking...");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.deepEqual(json.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  const methods = readLog(s.log)
    .map((m) => m.method)
    .filter(Boolean);
  assert.deepEqual(methods.slice(0, 2), ["initialize", "session/new"]);
  assert.equal(methods.at(-1), "session/prompt");
});

test("usage is estimated and flagged when the agent reports none", async () => {
  const { executor } = await makeExecutor({}, { FAKE_ACP_USAGE: "0" });
  const json = await completion(await run(executor, "say hi", false));
  assert.equal(json.usage.estimated, true);
  assert.ok(json.usage.prompt_tokens > 0);
  assert.ok(json.usage.completion_tokens > 0);
  assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens);
});

test("stream turn emits incremental OpenAI SSE chunks then [DONE]", async () => {
  const { executor } = await makeExecutor();
  const response = await run(executor, "say hi", true);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /data: \[DONE\]\s*$/);
  const events = sseEvents(text);
  assert.equal(events[0].object, "chat.completion.chunk");
  assert.equal(events[0].choices[0].delta.role, "assistant");
  const contentDeltas = events.map((e) => e.choices?.[0]?.delta?.content).filter((c) => c);
  assert.deepEqual(contentDeltas, ["hello ", "world"]);
  const reasoning = events.map((e) => e.choices?.[0]?.delta?.reasoning_content).filter(Boolean);
  assert.deepEqual(reasoning, ["thinking..."]);
  const last = events.at(-1);
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.deepEqual(last.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
});

test("stop reasons map to OpenAI finish reasons", async () => {
  const { executor } = await makeExecutor();
  const length = await completion(await run(executor, "MAXTOKENS", false));
  assert.equal(length.choices[0].finish_reason, "length");
  assert.equal(length.choices[0].message.content, "cut");
  const refused = await completion(await run(executor, "REFUSE", false));
  assert.equal(refused.choices[0].finish_reason, "content_filter");
});

test("output past the cap cancels the turn and ends as length with the capped text", async () => {
  const { executor, s } = await makeExecutor({ maxOutputBytes: 16 * 1024 });
  const json = await completion(await run(executor, "FLOOD", false));
  assert.equal(json.choices[0].finish_reason, "length");
  assert.ok(json.choices[0].message.content.length <= 16 * 1024);
  assert.ok(json.choices[0].message.content.length > 0);
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("an agent that cancels itself after producing text still returns that text", async () => {
  const { executor } = await makeExecutor();
  const json = await completion(await run(executor, "SELFCANCEL", false));
  assert.equal(json.choices[0].message.content, "partial answer");
  assert.equal(json.choices[0].finish_reason, "stop");
});

test("the flattened conversation reaches the agent as one text prompt block", async () => {
  const { executor, s } = await makeExecutor();
  const json = await completion(await run(executor, "ECHO me", false));
  assert.match(
    json.choices[0].message.content,
    /prompt=\[System\]\nYou are terse\.\n\n\[User\]\nECHO me/
  );
  const prompt = readLog(s.log).find((m) => m.method === "session/prompt");
  assert.equal(prompt?.params.prompt.length, 1);
  assert.equal(prompt?.params.prompt[0].type, "text");
});

// ── sandboxing of the agent ───────────────────────────────────────────────────

test("agent runs in a throw-away empty directory that is removed afterwards", async () => {
  const { executor, s } = await makeExecutor();
  const json = await completion(await run(executor, "ECHO", false));
  const content: string = json.choices[0].message.content;
  const cwd = /\|cwd=([^|]+)\|/.exec(content)?.[1] as string;
  const spawnCwd = /\|spawncwd=([^|]+)\|/.exec(content)?.[1] as string;
  assert.ok(cwd, "session/new cwd reported");
  assert.notEqual(cwd, process.cwd());
  assert.equal(spawnCwd, cwd);
  assert.equal(existsSync(cwd), false, "scratch cwd removed after the turn");
  const sessionNew = readLog(s.log).find((m) => m.method === "session/new");
  assert.deepEqual(sessionNew?.params.mcpServers, []);
});

test("an explicit cwd option is used as is and never deleted", async () => {
  const keep = mkdtempSync(join(tmpdir(), "omniroute-acp-keep-"));
  writeFileSync(join(keep, "marker"), "x");
  const { executor } = await makeExecutor({ cwd: keep });
  const json = await completion(await run(executor, "ECHO", false));
  assert.ok(json.choices[0].message.content.includes(`cwd=${keep}|`));
  assert.equal(existsSync(join(keep, "marker")), true);
});

test("client capabilities advertise no fs or terminal access", async () => {
  const { executor, s } = await makeExecutor();
  await run(executor, "say hi", false);
  const init = readLog(s.log).find((m) => m.method === "initialize");
  assert.equal(init?.params.protocolVersion, 1);
  assert.deepEqual(init?.params.clientCapabilities, {});
});

test("restrictive session mode is applied when the agent offers it", async () => {
  const { executor, s } = await makeExecutor({ sessionMode: "dontAsk" });
  const json = await completion(await run(executor, "ECHO", false));
  assert.match(json.choices[0].message.content, /\|mode=dontAsk\|/);
  assert.equal(
    readLog(s.log).some((m) => m.method === "session/set_mode"),
    true
  );
});

test("a session mode the agent does not offer is skipped with a warning", async () => {
  const { executor, s } = await makeExecutor({ sessionMode: "not-a-mode" });
  const warnings: string[] = [];
  const response = await run(executor, "say hi", false, {
    log: { warn: (_tag: string, message: string) => warnings.push(message) },
  });
  assert.equal(response.status, 200);
  assert.equal(
    warnings.some((w) => w.includes('does not offer session mode "not-a-mode"')),
    true
  );
  assert.equal(
    readLog(s.log).some((m) => m.method === "session/set_mode"),
    false
  );
});

// ── permissions and client-side requests ──────────────────────────────────────

test("permission requests are rejected by default", async () => {
  const { executor } = await makeExecutor();
  const json = await completion(await run(executor, "PERMISSION", false));
  assert.equal(json.choices[0].message.content, "permission:no");
});

test("permission policy allow selects the one-shot allow option", async () => {
  const { executor } = await makeExecutor({ permissionPolicy: "allow" });
  const json = await completion(await run(executor, "PERMISSION", false));
  assert.equal(json.choices[0].message.content, "permission:yes");
});

test("the allow policy logs a warning without secrets and still answers allow_once", async () => {
  const warnings: string[] = [];
  const log = { warn: (_tag: string, message: string) => warnings.push(message) };
  const allowing = await makeExecutor(
    { permissionPolicy: "allow" },
    { QODER_PERSONAL_ACCESS_TOKEN: "tok-secret-1234" }
  );
  const json = await completion(await run(allowing.executor, "PERMISSION", false, { log }));
  assert.equal(json.choices[0].message.content, "permission:yes");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ACP_PERMISSION_POLICY=allow/);
  assert.equal(warnings[0].includes("tok-secret-1234"), false);

  warnings.length = 0;
  const rejecting = await makeExecutor();
  await completion(await run(rejecting.executor, "PERMISSION", false, { log }));
  assert.equal(
    warnings.some((w) => w.includes("ACP_PERMISSION_POLICY=allow")),
    false
  );
});

test("permission with only allow options is cancelled under the reject policy", async () => {
  const { executor } = await makeExecutor({}, { FAKE_ACP_ONLY_ALLOW: "1" });
  const json = await completion(await run(executor, "PERMISSION", false));
  assert.equal(json.choices[0].message.content, "permission:cancelled");
});

test("fs and terminal requests from the agent are denied", async () => {
  const { executor } = await makeExecutor();
  const fs = await completion(await run(executor, "FSREAD", false));
  assert.equal(fs.choices[0].message.content, "fs:denied:-32000");
  const term = await completion(await run(executor, "TERMINAL", false));
  assert.equal(term.choices[0].message.content, "terminal:denied:-32000");
});

// ── model selection ───────────────────────────────────────────────────────────

test("a requested model other than the agent default is selected with session/set_model", async () => {
  const { executor, s } = await makeExecutor();
  const json = await completion(
    await executor
      .execute({ model: "beta", body: body("ECHO"), stream: false, credentials: {} })
      .then(unwrap)
  );
  assert.match(json.choices[0].message.content, /\|model=beta\|/);
  assert.equal(json.model, "beta");
  const setModel = readLog(s.log).find((m) => m.method === "session/set_model");
  assert.equal(setModel?.params.modelId, "beta");
});

test("a model the agent does not list is a 400 and the agent is stopped", async () => {
  const { executor, s } = await makeExecutor();
  const response = await executor
    .execute({ model: "gamma", body: body(), stream: false, credentials: {} })
    .then(unwrap);
  assert.equal(response.status, 400);
  const json = await completion(response);
  assert.match(json.error.message, /gamma/);
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("a model id that looks like a flag is refused before any process starts", async () => {
  const { executor, s } = await makeExecutor();
  const response = await executor
    .execute({ model: "--yolo", body: body(), stream: false, credentials: {} })
    .then(unwrap);
  assert.equal(response.status, 400);
  assert.equal(existsSync(s.pid), false);
});

test("an agent that reports no model list still serves the request", async () => {
  const { executor } = await makeExecutor({}, { FAKE_ACP_NO_MODELS: "1" });
  const response = await run(executor, "say hi", false);
  assert.equal(response.status, 200);
});

// ── credentials ───────────────────────────────────────────────────────────────

test("an api key is handed to the agent through its token environment variable only", async () => {
  const { executor, s } = await makeExecutor();
  const json = await completion(
    await executor
      .execute({
        model: "alpha",
        body: body("ECHO"),
        stream: false,
        credentials: { apiKey: "pt-dummy-token" },
      })
      .then(unwrap)
  );
  // The agent does receive it and echoes it back, but the echo never reaches the caller.
  assert.match(json.choices[0].message.content, /\|token=\[redacted\]\|/);
  assert.equal(json.choices[0].message.content.includes("pt-dummy-token"), false);
  assert.equal(
    JSON.stringify(readLog(s.log)).includes("pt-dummy-token"),
    false,
    "never on the wire"
  );
});

// ── masking the injected token in agent output ────────────────────────────────

const MASK_SECRET = "mask-me-token-9012";

/** Run one turn against a qwen-code-shaped agent whose token env is echoed back. */
async function runWithTokenEnvKey(text: string, stream: boolean, apiKey = MASK_SECRET) {
  const { executor } = await makeExecutor(
    {},
    { FAKE_ACP_TOKEN_ENV: "OPENAI_API_KEY" },
    "qwen-code"
  );
  return unwrap(
    await executor.execute({
      model: "alpha",
      body: body(text),
      stream,
      credentials: apiKey ? { apiKey } : {},
    })
  );
}

test("a token echoed bare, mid-word and across two streamed chunks is masked (non-stream)", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKOUT", false));
  const content: string = json.choices[0].message.content;
  assert.equal(content.includes(MASK_SECRET), false, "the key never appears in the content");
  assert.match(content, /say \[redacted\] now/); // bare
  assert.match(content, /abc\[redacted\]def/); // mid-word + split across chunks
});

test("a token echoed across streamed chunks is masked in every SSE delta", async () => {
  const response = await runWithTokenEnvKey("MASKOUT", true);
  const text = await response.text();
  assert.equal(text.includes(MASK_SECRET), false, "the key never appears in the stream");
  const deltas = sseEvents(text)
    .map((e) => e.choices?.[0]?.delta?.content)
    .filter((c) => c);
  assert.equal(
    deltas.some((delta) => delta.includes(MASK_SECRET)),
    false,
    "no delta carries the key"
  );
  // The key is never emitted in halves either: the withheld tail reassembles it whole.
  assert.equal(deltas.join(""), "say [redacted] nowabc[redacted]def");
  assert.match(text, /data: \[DONE\]\s*$/);
});

test("an injected value shorter than 8 characters is not masked", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKOUT", false, "abc123"));
  assert.match(json.choices[0].message.content, /say abc123 now/);
});

test("no connection key: the token report passes through untouched", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKOUT", false, ""));
  assert.match(json.choices[0].message.content, /no-token/);
});

test("a token appearing in the agent stderr tail is masked in the error", async () => {
  const response = await runWithTokenEnvKey("MASKSTDERR", false);
  assert.equal(response.status, 502);
  const json = await completion(response);
  assert.match(json.error.message, /exited|closed/i);
  assert.equal(json.error.message.includes(MASK_SECRET), false);
  assert.match(json.error.message, /\[redacted\]/);
});

test("a token appearing in a JSON-RPC error message is masked", async () => {
  const response = await runWithTokenEnvKey("MASKRPC", false);
  assert.equal(response.status, 401);
  const json = await completion(response);
  assert.match(json.error.message, /invalid credential/);
  assert.equal(json.error.message.includes(MASK_SECRET), false);
  // the generic sanitizer may overwrite the marker with its own [REDACTED]
  assert.match(json.error.message, /\[redacted\]/i);
});

test("a token in the stderr tail never reaches a stream request", async () => {
  const response = await runWithTokenEnvKey("MASKSTDERR", true);
  const text = await response.text();
  assert.equal(text.includes(MASK_SECRET), false);
  assert.match(text, /\[redacted\]/i);
});

// ── masking across content and reasoning ──────────────────────────────────────

test("a token echoed inside a reasoning chunk is masked out of reasoning_content", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKTHOUGHT", false));
  const reasoning: string = json.choices[0].message.reasoning_content ?? "";
  assert.equal(reasoning.includes(MASK_SECRET), false);
  assert.equal(reasoning, "think [redacted] end");
});

test("a token split between a thought chunk and a message chunk never reaches either field in halves", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKSPLITKIND", false));
  const content: string = json.choices[0].message.content;
  const reasoning: string = json.choices[0].message.reasoning_content ?? "";
  assert.equal(content.includes(MASK_SECRET.slice(9)), false, `content leaked a half: ${content}`);
  assert.equal(reasoning.includes(MASK_SECRET.slice(0, 9)), false, `reasoning leaked a half`);
  // The key completed across kinds, so it is one masked piece under the first kind.
  assert.equal(reasoning, "t-head [redacted]");
  assert.equal(content, " m-tail");
});

test("a token split across thought and message chunks is masked in every SSE delta", async () => {
  const response = await runWithTokenEnvKey("MASKSPLITKIND", true);
  const text = await response.text();
  assert.equal(text.includes(MASK_SECRET), false, "the whole key never appears in the stream");
  assert.equal(
    text.includes(MASK_SECRET.slice(9)),
    false,
    "no half of the key is ever released"
  );
  const events = sseEvents(text);
  const reasoning = events
    .map((e) => e.choices?.[0]?.delta?.reasoning_content)
    .filter((c) => c)
    .join("");
  const content = events
    .map((e) => e.choices?.[0]?.delta?.content)
    .filter((c) => c)
    .join("");
  assert.equal(reasoning, "t-head [redacted]");
  assert.equal(content, " m-tail");
});

test("a held partial prefix that never completes is released intact at the end of the turn", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKTAILHOLD", false));
  assert.equal(json.choices[0].message.content, `done ${MASK_SECRET.slice(0, 5)}`);
});

test("a key appearing twice in one chunk is masked in both places", async () => {
  const json = await completion(await runWithTokenEnvKey("MASKTWICE", false));
  assert.equal(json.choices[0].message.content, "[redacted] and [redacted]!");
});

test("a key split across three streamed chunks reassembles into one masked piece", async () => {
  const response = await runWithTokenEnvKey("MASKTHREEWAY", true);
  const text = await response.text();
  assert.equal(text.includes(MASK_SECRET), false);
  for (const half of [MASK_SECRET.slice(0, 4), MASK_SECRET.slice(4, 10), MASK_SECRET.slice(10)]) {
    assert.equal(text.includes(half), false, `half ${half} leaked`);
  }
  const content = sseEvents(text)
    .map((e) => e.choices?.[0]?.delta?.content)
    .filter((c) => c)
    .join("");
  assert.equal(content, "[redacted]");
});

test("text sharing a prefix with the key is not swallowed: only the real occurrence is masked", async () => {
  const json = await completion(
    await runWithTokenEnvKey("MASKOVERLAP", false, "abcabcabcXY123")
  );
  assert.equal(json.choices[0].message.content, "abcabc [redacted]!");
});

test("a client abort mid-stream flushes the held tail to the still-open consumer", async () => {
  const { executor } = await makeExecutor({ turnTimeoutMs: 20_000 });
  const controller = new AbortController();
  const response = unwrap(
    await executor.execute({
      model: "alpha",
      body: body("MASKPENDABORT"),
      stream: true,
      credentials: { apiKey: MASK_SECRET },
      signal: controller.signal,
    })
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("hmm ")) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  controller.abort();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  assert.equal(seen.includes(MASK_SECRET), false, "the full key never appears");
  assert.ok(
    seen.includes(MASK_SECRET.slice(0, 6)),
    "the held tail is flushed, not silently lost, when the consumer is still open"
  );
});

// ── the injected token value is the effective one ─────────────────────────────

const OVERRIDE_SECRET = "override-key-9988";

test("options.env cannot replace the connection key in the child's token env", async () => {
  const { executor } = await makeExecutor(
    {},
    { FAKE_ACP_TOKEN_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: OVERRIDE_SECRET },
    "qwen-code"
  );
  const json = await completion(
    await executor
      .execute({
        model: "alpha",
        body: body("ENVREPORT"),
        stream: false,
        credentials: { apiKey: MASK_SECRET },
      })
      .then(unwrap)
  );
  const content: string = json.choices[0].message.content;
  assert.match(
    content,
    new RegExp(`OPENAI_API_KEY=set:${hash8(MASK_SECRET)}\\b`),
    "the connection key wins over the options.env override"
  );
  assert.equal(content.includes(hash8(OVERRIDE_SECRET)), false, "the override never lands");
});

test("an options.env override attempt cannot unmask: the agent can only echo a masked value", async () => {
  const { executor } = await makeExecutor(
    {},
    { FAKE_ACP_TOKEN_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: OVERRIDE_SECRET },
    "qwen-code"
  );
  const json = await completion(await run(executor, "MASKOUT", false));
  const content: string = json.choices[0].message.content;
  assert.equal(content.includes(MASK_SECRET), false);
  assert.equal(
    content.includes(OVERRIDE_SECRET),
    false,
    "whatever value the child ends up holding under the token env is masked"
  );
});

test("a token env value coming only from options.env is still masked as an injected token", async () => {
  const { executor } = await makeExecutor(
    {},
    { FAKE_ACP_TOKEN_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: OVERRIDE_SECRET },
    "qwen-code"
  );
  const json = await completion(await run(executor, "MASKOUT", false));
  assert.equal(json.choices[0].message.content.includes(OVERRIDE_SECRET), false);
  assert.match(json.choices[0].message.content, /say \[redacted\] now/);
});

test("an ACP RPC error's data payload never carries the injected token", async () => {
  const { AcpClient, AcpRpcError, buildAcpChildEnv } = await import(
    "../../open-sse/executors/acpProtocol.ts"
  );
  const client = new AcpClient({
    command: process.execPath,
    args: [fixture],
    env: buildAcpChildEnv(
      { FAKE_ACP_TOKEN_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: MASK_SECRET },
      [],
      {}
    ),
    secrets: [MASK_SECRET],
    requestTimeoutMs: 3000,
  });
  client.start();
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const error = await client
      .request(
        "session/prompt",
        { sessionId: "fake-session", prompt: [{ type: "text", text: "MASKERRDATA" }] },
        0
      )
      .then(() => undefined, (err: unknown) => err);
    assert.ok(error instanceof AcpRpcError, "the prompt must fail with an RPC error");
    const carried = JSON.stringify((error as AcpRpcError).data) ?? "";
    assert.equal(carried.includes(MASK_SECRET), false, "err.data must not carry the key");
    assert.match(carried, /\[redacted\]/);
  } finally {
    await client.close();
  }
});

// ── the environment and argv given to the child ───────────────────────────────

const GW_OPENAI_SECRET = "gw-secret-0001";
const GW_QODER_SECRET = "gw-qoder-0002";
const CONN_KEY = "conn-key-xyz123";
const REPORTED_VARS = "OPENAI_API_KEY,QODER_PERSONAL_ACCESS_TOKEN";

function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Ask the fixture how the named variables look inside the child, as set:<hash8>/unset. */
async function childEnvReport(agentId: string, apiKey: string): Promise<string> {
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    QODER_PERSONAL_ACCESS_TOKEN: process.env.QODER_PERSONAL_ACCESS_TOKEN,
  };
  process.env.OPENAI_API_KEY = GW_OPENAI_SECRET;
  process.env.QODER_PERSONAL_ACCESS_TOKEN = GW_QODER_SECRET;
  try {
    const { executor } = await makeExecutor({}, { FAKE_ACP_REPORT_VARS: REPORTED_VARS }, agentId);
    const response = unwrap(
      await executor.execute({
        model: "alpha",
        body: body("ENVREPORT"),
        stream: false,
        credentials: apiKey ? { apiKey } : {},
      })
    );
    const json = await completion(response);
    if (json.error) return `ERROR ${response.status}: ${json.error.message}`;
    return json.choices[0].message.content;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("qwen-code gets the connection key in OPENAI_API_KEY, never the gateway's own", async () => {
  const report = await childEnvReport("qwen-code", CONN_KEY);
  assert.match(report, new RegExp(`OPENAI_API_KEY=set:${hash8(CONN_KEY)}\\b`));
  assert.equal(report.includes(hash8(GW_OPENAI_SECRET)), false);
  assert.match(report, /QODER_PERSONAL_ACCESS_TOKEN=unset/);
  assert.equal(
    [CONN_KEY, GW_OPENAI_SECRET, GW_QODER_SECRET].some((secret) => report.includes(secret)),
    false,
    "no value is ever printed, and none travels in argv"
  );
});

test("qwen-code with no connection key leaves OPENAI_API_KEY unset in the child", async () => {
  const report = await childEnvReport("qwen-code", "");
  assert.match(report, /OPENAI_API_KEY=unset/);
  assert.match(report, /QODER_PERSONAL_ACCESS_TOKEN=unset/);
});

test("qoder gets the connection key in QODER_PERSONAL_ACCESS_TOKEN", async () => {
  const report = await childEnvReport("qoder", CONN_KEY);
  assert.match(report, new RegExp(`QODER_PERSONAL_ACCESS_TOKEN=set:${hash8(CONN_KEY)}\\b`));
  assert.match(report, /OPENAI_API_KEY=unset/);
  assert.equal(report.includes(hash8(GW_QODER_SECRET)), false);
});

test("opencode has no token env and receives neither variable", async () => {
  const report = await childEnvReport("opencode", CONN_KEY);
  assert.match(report, /OPENAI_API_KEY=unset/);
  assert.match(report, /QODER_PERSONAL_ACCESS_TOKEN=unset/);
});

test("gateway environment variables are not inherited by the agent", async () => {
  process.env.OMNIROUTE_ACP_LEAK_PROBE = "gateway-secret";
  try {
    const { executor } = await makeExecutor();
    const json = await completion(await run(executor, "ECHO", false));
    assert.match(json.choices[0].message.content, /\|leak=none$/);
  } finally {
    delete process.env.OMNIROUTE_ACP_LEAK_PROBE;
  }
});

// ── failures ──────────────────────────────────────────────────────────────────

test("a missing binary is a clear 502 and does not throw", async () => {
  const { AcpExecutor } = await load();
  const executor = new AcpExecutor("qoder", {
    command: join(tmpdir(), "definitely-not-a-binary-acp"),
    args: [],
  });
  const response = await run(executor, "hi", false);
  assert.equal(response.status, 502);
  const json = await completion(response);
  assert.match(json.error.message, /not found|ENOENT|spawn/i);
});

test("the agent dying mid-turn is a 502 with scrubbed stderr, and nothing leaks", async () => {
  const { executor, s } = await makeExecutor();
  const response = await run(executor, "DIE", false);
  assert.equal(response.status, 502);
  const json = await completion(response);
  assert.match(json.error.message, /exited|closed/i);
  assert.equal(json.error.message.includes("sk-abc123def456ghi789jkl012mno"), false);
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("an agent that dies after partial output ends the SSE stream with an error event", async () => {
  const { executor } = await makeExecutor();
  const response = await run(executor, "DIE", true);
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = sseEvents(text);
  assert.equal(
    events.some((e) => e.choices?.[0]?.delta?.content === "partial "),
    true
  );
  assert.equal(
    events.some((e) => e.error),
    true
  );
  assert.match(text, /data: \[DONE\]\s*$/);
});

test("an agent error before any output becomes an HTTP error, auth errors map to 401", async () => {
  const { executor } = await makeExecutor();
  const response = await run(executor, "EARLYERR", true);
  assert.equal(response.status, 401);
  const json = await completion(response);
  assert.match(json.error.message, /Authentication required/);
});

test("a turn that outlives the timeout is cancelled, killed and reported as 504", async () => {
  const { executor, s } = await makeExecutor({ turnTimeoutMs: 150 });
  const response = await run(executor, "HANG", false);
  assert.equal(response.status, 504);
  assert.equal(
    readLog(s.log).some((m) => m.method === "session/cancel"),
    true
  );
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("client abort cancels the session and kills the agent", async () => {
  const { executor, s } = await makeExecutor({ turnTimeoutMs: 20_000 });
  const controller = new AbortController();
  const pending = executor.execute({
    model: "alpha",
    body: body("HANG"),
    stream: false,
    credentials: {},
    signal: controller.signal,
  });
  assert.equal(
    await waitFor(() => readLog(s.log).some((m) => m.method === "session/prompt")),
    true
  );
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(
    readLog(s.log).some((m) => m.method === "session/cancel"),
    true
  );
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("a multi-byte character split across stdout chunks arrives intact", async () => {
  const { executor } = await makeExecutor();
  const json = await completion(await run(executor, "SPLITUTF8", false));
  assert.equal(json.choices[0].message.content, "café");
});

test("a request aborted before it starts never spawns the agent", async () => {
  const { executor, s } = await makeExecutor();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executor.execute({
      model: "alpha",
      body: body("say hi"),
      stream: false,
      credentials: {},
      signal: controller.signal,
    }),
    (error: Error) => error.name === "AbortError"
  );
  assert.equal(existsSync(s.pid), false);
});

test("an agent that ignores cancel and SIGTERM is SIGKILLed, the request ends and the slot frees", async () => {
  const { executor, s } = await makeExecutor({ turnTimeoutMs: 400 });
  const response = await run(executor, "STUBBORN", false);
  assert.equal(response.status, 504);
  assert.equal(await waitFor(() => !pidAlive(s.pid), 8000), true);
});

test("cancelling the SSE reader cancels the session and kills the agent", async () => {
  const { executor, s } = await makeExecutor({ turnTimeoutMs: 20_000 });
  const response = await run(executor, "HANG", true);
  const reader = response.body!.getReader();
  await reader.read(); // role chunk
  await reader.cancel();
  assert.equal(
    await waitFor(() => readLog(s.log).some((m) => m.method === "session/cancel")),
    true
  );
  assert.equal(await waitFor(() => !pidAlive(s.pid)), true);
});

test("concurrent turns above the limit are refused with 429", async () => {
  const { executor } = await makeExecutor({ maxConcurrent: 1, turnTimeoutMs: 20_000 });
  const controller = new AbortController();
  const first = executor
    .execute({
      model: "alpha",
      body: body("HANG"),
      stream: false,
      credentials: {},
      signal: controller.signal,
    })
    .catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  const second = await run(executor, "say hi", false);
  assert.equal(second.status, 429);
  controller.abort();
  await first;
  const third = await run(executor, "say hi", false);
  assert.equal(third.status, 200, "slot is released after abort");
});

// ── wiring ────────────────────────────────────────────────────────────────────

test("qoder-acp is a registered provider backed by the ACP executor", async () => {
  const { qoderAcpProvider } =
    await import("../../open-sse/config/providers/registry/qoder-acp/index.ts");
  assert.equal(qoderAcpProvider.id, "qoder-acp");
  assert.equal(qoderAcpProvider.executor, "qoder-acp");
  assert.equal(qoderAcpProvider.format, "openai");
  assert.equal(qoderAcpProvider.baseUrl, "acp://qoder/stdio");
  assert.ok(qoderAcpProvider.models.length > 0);
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const { AcpExecutor } = await load();
  const executor = await getExecutor("qoder-acp");
  assert.ok(executor instanceof AcpExecutor);
});
