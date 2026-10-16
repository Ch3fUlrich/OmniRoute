// AutoOS: Scaleway rejects qwen3-235b-a22b-instruct-2507 requests above 16384 completion tokens.
import test from "node:test";
import assert from "node:assert/strict";

const { stripUnsupportedParams } = await import("../../open-sse/translator/paramSupport.ts");

test("scaleway qwen3-235b-a22b-instruct-2507 clamps every max-token key to 16384", () => {
  const body = { max_tokens: 32000, max_completion_tokens: 40000, max_output_tokens: 20000 };
  stripUnsupportedParams("scaleway", "qwen3-235b-a22b-instruct-2507", body);
  assert.deepEqual(body, { max_tokens: 16384, max_completion_tokens: 16384, max_output_tokens: 16384 });
});

test("in-range value and other models are untouched", () => {
  const a = { max_tokens: 1000 };
  stripUnsupportedParams("scaleway", "qwen3-235b-a22b-instruct-2507", a);
  assert.equal(a.max_tokens, 1000);
  const b = { max_tokens: 32000 };
  stripUnsupportedParams("scaleway", "some-other-model", b);
  assert.equal(b.max_tokens, 32000);
});
