// AutoOS: a model's explicit output cap clamps max_tokens even for models that are not
// thinking-capable (the clamp used to be gated on supportsThinking).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-clamp-nothink-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { resolveReasoningBufferedMaxTokens } =
  await import("../../open-sse/services/reasoningTokenBuffer.ts");

const entry = (limitOutput: number | null) => ({
  tool_call: true,
  reasoning: false,
  attachment: false,
  structured_output: true,
  temperature: true,
  modalities_input: JSON.stringify(["text"]),
  modalities_output: JSON.stringify(["text"]),
  knowledge_cutoff: null,
  release_date: null,
  last_updated: null,
  status: null,
  family: null,
  open_weights: false,
  limit_context: 100000,
  limit_input: 100000,
  limit_output: limitOutput,
  interleaved_field: null,
});

test.before(() => {
  saveModelsDevCapabilities({
    openai: {
      "autoos-plain-capped-9001": entry(4096),
      "autoos-plain-uncapped-9001": entry(null),
    },
  });
});
test.after(() => {
  clearModelsDevCapabilities();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("non-thinking model with an explicit cap is clamped to it", () => {
  assert.equal(resolveReasoningBufferedMaxTokens("openai/autoos-plain-capped-9001", 32000), 4096);
});
test("in-range value is forwarded verbatim; no cap leaves it untouched", () => {
  assert.equal(resolveReasoningBufferedMaxTokens("openai/autoos-plain-capped-9001", 1000), 1000);
  assert.equal(resolveReasoningBufferedMaxTokens("openai/autoos-plain-uncapped-9001", 32000), null);
});
