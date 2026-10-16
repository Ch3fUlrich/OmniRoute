import test from "node:test";
import assert from "node:assert/strict";

// Vertex rejects `contents[]` that ends on a model turn, and answers the same 400
// "Requests ending with a model turn are not supported" for a user turn that mixes a
// functionResponse part with other parts. guardGeminiTrailingTurn fixes both shapes.

const { guardGeminiTrailingTurn, openaiToGeminiRequest } = await import(
  "../../open-sse/translator/request/openai-to-gemini.ts"
);

const fr = (name: string) => ({ functionResponse: { name, response: { ok: true } } });
const user = (...parts: Array<Record<string, unknown>>) => ({ role: "user", parts });
const model = (...parts: Array<Record<string, unknown>>) => ({ role: "model", parts });

test("lone model turn is popped and refilled with a Continue user turn", () => {
  assert.deepEqual(guardGeminiTrailingTurn([model({ text: "x" })]), [user({ text: "Continue." })]);
});

test("model tail behind a user history is popped", () => {
  const out = guardGeminiTrailingTurn([user({ text: "a" }), model({ text: "b" })]);
  assert.deepEqual(out, [user({ text: "a" })]);
});

test("several trailing model turns and an all-model history", () => {
  assert.deepEqual(guardGeminiTrailingTurn([user({ text: "a" }), model({ text: "b" }), model({ text: "c" })]), [
    user({ text: "a" }),
  ]);
  assert.deepEqual(guardGeminiTrailingTurn([model({ text: "b" }), model({ text: "c" })]), [
    user({ text: "Continue." }),
  ]);
});

test("user tail and text-only / functionResponse-only turns are untouched", () => {
  const a = [user({ text: "a" }), model({ functionCall: { name: "f" } }), user(fr("f"))];
  assert.deepEqual(guardGeminiTrailingTurn(a), a);
});

test("empty and non-array contents are refilled", () => {
  assert.deepEqual(guardGeminiTrailingTurn([]), [user({ text: "Continue." })]);
  assert.deepEqual(guardGeminiTrailingTurn(undefined), [user({ text: "Continue." })]);
});

test("D-908: single mixed functionResponse+text user turn is split", () => {
  const out = guardGeminiTrailingTurn([
    user({ text: "go" }),
    model({ functionCall: { name: "f" } }),
    user(fr("f"), { text: "notice" }),
  ]);
  assert.deepEqual(out.slice(2), [
    user(fr("f")),
    model({ text: "Noted." }),
    user({ text: "notice" }),
  ]);
  assert.equal(out[out.length - 1].role, "user");
});

test("D-908: parallel functionResponses keep order and stay together", () => {
  const out = guardGeminiTrailingTurn([
    model({ functionCall: { name: "f" } }, { functionCall: { name: "g" } }),
    user({ text: "pre" }, fr("f"), fr("g"), { text: "post" }),
  ]);
  assert.deepEqual(out, [
    model({ functionCall: { name: "f" } }, { functionCall: { name: "g" } }),
    user(fr("f"), fr("g")),
    model({ text: "Noted." }),
    user({ text: "pre" }, { text: "post" }),
  ]);
});

test("malformed entries are skipped, parts null/missing tolerated, model-side functionResponse passes", () => {
  const out = guardGeminiTrailingTurn([
    null,
    "x",
    { role: "system", parts: [] },
    { role: "user", parts: null },
    { role: "user" },
    model(fr("f")),
    user({ text: "t" }),
  ] as unknown);
  assert.deepEqual(out, [{ role: "user", parts: null }, { role: "user" }, model(fr("f")), user({ text: "t" })]);
});

test("openaiToGeminiRequest: tool result followed by user text ends on user with a split", () => {
  const body = {
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "user", content: "notice" },
    ],
  };
  const { contents } = openaiToGeminiRequest("gemini-2.5-pro", body, false) as {
    contents: Array<{ role: string }>;
  };
  assert.equal(contents[contents.length - 1].role, "user");
  for (let i = 1; i < contents.length; i++) assert.notEqual(contents[i].role, contents[i - 1].role);
});
