/**
 * The explicit-output-cap clamp in `resolveReasoningBufferedMaxTokens` applies to
 * EVERY model, not only thinking-capable ones.
 *
 * A non-thinking model with an oversized `max_tokens` gets the same upstream 400
 * ("exceeds model's maximum output tokens") a thinking model does, so the model's
 * explicit `limit_output` ceiling must clamp it regardless of `reasoning` support.
 *
 * Contracts asserted here:
 *   - reasoning:false + limit_output 4096 + max_tokens 32000 -> 4096 (clamped)
 *   - reasoning:false + limit_output 4096 + max_tokens 1000  -> 1000 (in range, verbatim)
 *   - model with no explicit output cap                       -> null  (untouched)
 *
 * Kept standalone against the pure helper, matching the sibling #6274/#9507 files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-max-tokens-clamp-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { resolveReasoningBufferedMaxTokens } =
  await import("../../open-sse/services/reasoningTokenBuffer.ts");

function capabilityEntry(limitContext: unknown, overrides: Record<string, unknown> = {}) {
  return {
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
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
    ...overrides,
  };
}

test.before(() => {
  // Synthetic ids: no MODEL_SPECS prefix match, no registry row — only the synced
  // row below provides an output cap (same guard as #6274/#6714).
  saveModelsDevCapabilities({
    "fictitious-provider": {
      "fictitious-nonthinking-clamped-4096": capabilityEntry(128000, {
        reasoning: false,
        limit_output: 4096,
      }),
      "fictitious-nonthinking-no-output-cap": capabilityEntry(128000, {
        reasoning: false,
        limit_output: null,
      }),
    },
  });
});

test.after(() => {
  clearModelsDevCapabilities();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("explicit output cap clamps an oversized max_tokens on a NON-thinking model", () => {
  assert.equal(
    resolveReasoningBufferedMaxTokens(
      "fictitious-provider/fictitious-nonthinking-clamped-4096",
      32000
    ),
    4096,
    "32000 must be clamped to the model's 4096 limit_output even with reasoning:false"
  );
});

test("explicit output cap leaves an in-range max_tokens verbatim on a NON-thinking model", () => {
  assert.equal(
    resolveReasoningBufferedMaxTokens(
      "fictitious-provider/fictitious-nonthinking-clamped-4096",
      1000
    ),
    1000,
    "1000 is under the 4096 cap and must pass through untouched"
  );
});

test("tiny probe values below the trigger stay verbatim on a NON-thinking model", () => {
  assert.equal(
    resolveReasoningBufferedMaxTokens("fictitious-provider/fictitious-nonthinking-clamped-4096", 1),
    1,
    "probe-sized max_tokens must not be rewritten"
  );
});

test("a NON-thinking model with no explicit output cap is left untouched (null)", () => {
  assert.equal(
    resolveReasoningBufferedMaxTokens(
      "fictitious-provider/fictitious-nonthinking-no-output-cap",
      32000
    ),
    null,
    "no explicit cap -> no clamp, the helper returns null"
  );
});
