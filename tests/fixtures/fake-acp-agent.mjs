// Fake Agent Client Protocol agent used by the ACP executor tests. It speaks
// newline-delimited JSON-RPC 2.0 on stdio. Behaviour is selected by magic words
// in the prompt text so a single script covers every path; it never touches the
// network or the filesystem except the optional log/pid files named in env.
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_ACP_LOG;
const PIDFILE = process.env.FAKE_ACP_PIDFILE;
if (PIDFILE) writeFileSync(PIDFILE, String(process.pid));

// The environment variable the executor is expected to inject the connection token
// into; tests aiming at another agent point it at that agent's `tokenEnv`.
const TOKEN_ENV = process.env.FAKE_ACP_TOKEN_ENV || "QODER_PERSONAL_ACCESS_TOKEN";
const TOKEN = process.env[TOKEN_ENV] || "";
// Variables an env-report test asks about (comma-separated names).
const REPORT_VARS = (process.env.FAKE_ACP_REPORT_VARS || "").split(",").filter(Boolean);

function envReport(name) {
  const value = process.env[name];
  if (typeof value !== "string") return "unset";
  // Never print the value: only whether it is set and a short hash of it.
  return `set:${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

const MODELS = (process.env.FAKE_ACP_MODELS || "alpha,beta").split(",").filter(Boolean);
const NO_MODELS = process.env.FAKE_ACP_NO_MODELS === "1";
const MODES = ["default", "dontAsk", "yolo"];

let sessionCwd = "";
let selectedModel = MODELS[0];
let selectedMode = "default";
let promptId = null;
let stubborn = false;
let nextOutbound = 1000;
const pendingOutbound = new Map();

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function update(update) {
  send({ method: "session/update", params: { sessionId: "fake-session", update } });
}
function chunk(kind, text) {
  update({ sessionUpdate: kind, content: { type: "text", text } });
}
function askClient(method, params) {
  const id = nextOutbound++;
  return new Promise((resolve) => {
    pendingOutbound.set(id, resolve);
    send({ id, method, params });
  });
}
function promptText(params) {
  return (params.prompt || [])
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join("");
}
function finish(stopReason, extra = {}) {
  send({ id: promptId, result: { stopReason, ...extra } });
  promptId = null;
}

async function handlePrompt(id, params) {
  promptId = id;
  const text = promptText(params);
  if (text.includes("STUBBORN")) {
    // Ignores session/cancel and SIGTERM: only SIGKILL stops it.
    process.on("SIGTERM", () => undefined);
    stubborn = true;
    chunk("agent_message_chunk", "partial ");
    return;
  }
  if (text.includes("SELFCANCEL")) {
    chunk("agent_message_chunk", "partial answer");
    return finish("cancelled");
  }
  if (text.includes("FLOOD")) {
    for (let i = 0; i < 64; i += 1) chunk("agent_message_chunk", "x".repeat(1024));
    return; // answer only after session/cancel
  }
  if (text.includes("HANG")) {
    chunk("agent_message_chunk", "partial ");
    return; // answer only after session/cancel
  }
  if (text.includes("DIE")) {
    chunk("agent_message_chunk", "partial ");
    process.stderr.write("fake agent exploded: secret-looking sk-abc123def456ghi789jkl012mno\n");
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (text.includes("PERMISSION")) {
    const reply = await askClient("session/request_permission", {
      sessionId: "fake-session",
      toolCall: { toolCallId: "t1", title: "rm -rf", kind: "execute" },
      options: process.env.FAKE_ACP_ONLY_ALLOW
        ? [{ optionId: "yes", name: "Allow", kind: "allow_once" }]
        : [
            { optionId: "yes-always", name: "Always", kind: "allow_always" },
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
    });
    const outcome = reply.result?.outcome;
    chunk(
      "agent_message_chunk",
      `permission:${outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome}`
    );
    return finish("end_turn");
  }
  if (text.includes("FSREAD")) {
    const reply = await askClient("fs/read_text_file", {
      sessionId: "fake-session",
      path: "/etc/hostname",
    });
    chunk("agent_message_chunk", reply.error ? `fs:denied:${reply.error.code}` : "fs:allowed");
    return finish("end_turn");
  }
  if (text.includes("TERMINAL")) {
    const reply = await askClient("terminal/create", { sessionId: "fake-session", command: "ls" });
    chunk(
      "agent_message_chunk",
      reply.error ? `terminal:denied:${reply.error.code}` : "terminal:allowed"
    );
    return finish("end_turn");
  }
  if (text.includes("EARLYERR")) {
    send({ id, error: { code: -32000, message: "Authentication required" } });
    promptId = null;
    return;
  }
  if (text.includes("SPLITUTF8")) {
    // One JSON line whose multi-byte character ("é" = 0xC3 0xA9) is cut across two writes.
    const line = Buffer.from(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "café" } },
        },
      })}\n`,
      "utf8"
    );
    const cut = line.indexOf(0xc3) + 1;
    process.stdout.write(line.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.stdout.write(line.subarray(cut));
    return finish("end_turn");
  }
  if (text.includes("MAXTOKENS")) {
    chunk("agent_message_chunk", "cut");
    return finish("max_tokens");
  }
  if (text.includes("REFUSE")) {
    return finish("refusal");
  }
  if (text.includes("ENVREPORT")) {
    const vars = REPORT_VARS.map((name) => `${name}=${envReport(name)}`).join(",");
    const argv = process.argv
      .slice(1)
      .map((a) => JSON.stringify(a))
      .join(" ");
    chunk("agent_message_chunk", `envreport|${vars}|argv=${argv}|`);
    return finish("end_turn");
  }
  if (text.includes("MASKTHOUGHT")) {
    // Echo the token inside a reasoning chunk.
    if (!TOKEN) {
      chunk("agent_thought_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_thought_chunk", `think ${TOKEN} end`);
    return finish("end_turn");
  }
  if (text.includes("MASKSPLITKIND")) {
    // One key split across kinds: the thought chunk carries the head, the message
    // chunk the tail. Neither half may reach the caller.
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_thought_chunk", `t-head ${TOKEN.slice(0, 9)}`);
    chunk("agent_message_chunk", `${TOKEN.slice(9)} m-tail`);
    return finish("end_turn");
  }
  if (text.includes("MASKTAILHOLD")) {
    // Text ends with a proper key prefix that never completes: it must be released
    // intact when the turn ends, not withheld forever or masked.
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_message_chunk", `done ${TOKEN.slice(0, 5)}`);
    return finish("end_turn");
  }
  if (text.includes("MASKTWICE")) {
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_message_chunk", `${TOKEN} and ${TOKEN}!`);
    return finish("end_turn");
  }
  if (text.includes("MASKTHREEWAY")) {
    // One key split across three chunks.
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_message_chunk", TOKEN.slice(0, 4));
    chunk("agent_message_chunk", TOKEN.slice(4, 10));
    chunk("agent_message_chunk", TOKEN.slice(10));
    return finish("end_turn");
  }
  if (text.includes("MASKOVERLAP")) {
    // The text before the key shares a prefix with it ("abcabc " against
    // "abcabcabcXY123"): only the real occurrence may be masked.
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_message_chunk", `abcabc ${TOKEN}!`);
    return finish("end_turn");
  }
  if (text.includes("MASKPENDABORT")) {
    // A held partial prefix with the turn still open: only the client abort ends it,
    // so the withheld tail must be flushed to the consumer, not lost.
    if (!TOKEN) {
      chunk("agent_thought_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_thought_chunk", `hmm ${TOKEN.slice(0, 6)}`);
    return;
  }
  if (text.includes("MASKERRDATA")) {
    send({
      id,
      error: {
        code: -32000,
        message: "rpc failure",
        data: { detail: `token is ${TOKEN || "none"}` },
      },
    });
    promptId = null;
    return;
  }
  if (text.includes("MASKOUT")) {
    // Echo the injected token bare, mid-word, and split across two chunks. A missing
    // token is reported as such so the test can tell an injection failure from a
    // masking failure.
    if (!TOKEN) {
      chunk("agent_message_chunk", "no-token");
      return finish("end_turn");
    }
    chunk("agent_message_chunk", `say ${TOKEN} now`);
    chunk("agent_message_chunk", `abc${TOKEN.slice(0, 4)}`);
    chunk("agent_message_chunk", `${TOKEN.slice(4)}def`);
    return finish("end_turn");
  }
  if (text.includes("MASKSTDERR")) {
    process.stderr.write(`fake agent exploded: token is ${TOKEN || "none"}\n`);
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (text.includes("MASKRPC")) {
    send({ id, error: { code: -32000, message: `invalid credential: ${TOKEN || "none"}` } });
    promptId = null;
    return;
  }
  if (text.includes("ECHO")) {
    chunk("agent_message_chunk", `prompt=${text}`);
    chunk("agent_message_chunk", `|cwd=${sessionCwd}|model=${selectedModel}|mode=${selectedMode}`);
    chunk("agent_message_chunk", `|token=${TOKEN || "none"}`);
    chunk("agent_message_chunk", `|spawncwd=${process.cwd()}`);
    chunk("agent_message_chunk", `|leak=${process.env.OMNIROUTE_ACP_LEAK_PROBE || "none"}`);
    return finish("end_turn");
  }
  chunk("agent_thought_chunk", "thinking...");
  chunk("agent_message_chunk", "hello ");
  chunk("agent_message_chunk", "world");
  update({ sessionUpdate: "tool_call", toolCallId: "t0", title: "ignored", status: "pending" });
  update({ sessionUpdate: "usage_update", used: 10, size: 1000 });
  const usage =
    process.env.FAKE_ACP_USAGE === "0"
      ? {}
      : { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
  return finish("end_turn", usage);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log(message);
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingOutbound.get(message.id);
    if (resolve) {
      pendingOutbound.delete(message.id);
      resolve(message);
    }
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: {} },
          agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
          authMethods: [],
        },
      });
    case "session/new": {
      sessionCwd = params.cwd;
      const result = {
        sessionId: "fake-session",
        modes: {
          currentModeId: "default",
          availableModes: MODES.map((m) => ({ id: m, name: m })),
        },
      };
      if (!NO_MODELS) {
        result.models = {
          currentModelId: MODELS[0],
          availableModels: MODELS.map((m) => ({ modelId: m, name: m })),
        };
      }
      return send({ id, result });
    }
    case "session/set_model":
      selectedModel = params.modelId;
      return send({ id, result: {} });
    case "session/set_mode":
      selectedMode = params.modeId;
      return send({ id, result: {} });
    case "session/prompt":
      return void handlePrompt(id, params);
    case "session/cancel":
      if (promptId !== null && !stubborn) finish("cancelled");
      return;
    default:
      if (id !== undefined)
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
