/**
 * Scaleway rejects oversized max-output-token values for
 * `qwen3-235b-a22b-instruct-2507` with HTTP 400
 * "max_completion_tokens is limited to 16384".
 *
 * STRIP_RULES entry: provider "scaleway", exact model id,
 * `maxOutputCap: 16384` + `clampToModelMaxOutput: true`.
 *
 * Asserted here:
 *   - max_tokens / max_completion_tokens / max_output_tokens all clamp to 16384
 *     when above the cap
 *   - an in-range value (1000) passes through untouched
 *   - other Scaleway models and other providers are not clamped by this rule
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUnsupportedParams } from "../../open-sse/translator/paramSupport.ts";

const MODEL = "qwen3-235b-a22b-instruct-2507";

test("scaleway qwen3-235b-a22b-instruct-2507 clamps max_tokens to 16384", () => {
  const body: Record<string, unknown> = { max_tokens: 32000 };
  stripUnsupportedParams("scaleway", MODEL, body);
  assert.equal(body.max_tokens, 16384, "max_tokens must clamp to the Scaleway 16384 ceiling");
});

test("scaleway qwen3-235b-a22b-instruct-2507 clamps max_completion_tokens to 16384", () => {
  const body: Record<string, unknown> = { max_completion_tokens: 65536 };
  stripUnsupportedParams("scaleway", MODEL, body);
  assert.equal(
    body.max_completion_tokens,
    16384,
    "the Scaleway 400 names max_completion_tokens; it must clamp too"
  );
});

test("scaleway qwen3-235b-a22b-instruct-2507 clamps max_output_tokens to 16384", () => {
  const body: Record<string, unknown> = { max_output_tokens: 32768 };
  stripUnsupportedParams("scaleway", MODEL, body);
  assert.equal(body.max_output_tokens, 16384, "max_output_tokens clamps with its siblings");
});

test("scaleway qwen3-235b-a22b-instruct-2507 clamps all three keys in one body", () => {
  const body: Record<string, unknown> = {
    max_tokens: 32000,
    max_completion_tokens: 32000,
    max_output_tokens: 32000,
    temperature: 0.4,
  };
  stripUnsupportedParams("scaleway", MODEL, body);
  assert.equal(body.max_tokens, 16384);
  assert.equal(body.max_completion_tokens, 16384);
  assert.equal(body.max_output_tokens, 16384);
  assert.equal(body.temperature, 0.4, "unrelated params must survive");
});

test("scaleway qwen3-235b-a22b-instruct-2507 leaves an in-range value untouched", () => {
  const body: Record<string, unknown> = {
    max_tokens: 1000,
    max_completion_tokens: 1000,
    max_output_tokens: 1000,
  };
  stripUnsupportedParams("scaleway", MODEL, body);
  assert.equal(body.max_tokens, 1000, "values at or under the cap must not be raised or lowered");
  assert.equal(body.max_completion_tokens, 1000);
  assert.equal(body.max_output_tokens, 1000);
});

test("scaleway rule does not clamp other scaleway models", () => {
  const body: Record<string, unknown> = { max_tokens: 32000 };
  stripUnsupportedParams("scaleway", "qwen3-235b-a22b-instruct-2508", body);
  assert.equal(body.max_tokens, 32000, "near-match ids are outside the exact-id rule");

  const other: Record<string, unknown> = { max_tokens: 32000 };
  stripUnsupportedParams("scaleway", "deepseek-v4-flash", other);
  assert.equal(other.max_tokens, 32000, "unrelated scaleway models are untouched");
});

test("scaleway rule is provider-scoped (other providers with the same model id are untouched)", () => {
  const body: Record<string, unknown> = { max_tokens: 32000 };
  stripUnsupportedParams("openrouter", MODEL, body);
  assert.equal(body.max_tokens, 32000, "the Scaleway ceiling must not leak to other providers");
});
