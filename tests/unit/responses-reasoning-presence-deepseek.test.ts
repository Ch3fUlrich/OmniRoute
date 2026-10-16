// DeepSeek / Xiaomi MiMo thinking mode 400 when a Responses input function_call has no
// preceding reasoning item. On a reasoning-cache miss a placeholder reasoning item is injected.
import test from "node:test";
import assert from "node:assert/strict";

const { openaiToOpenAIResponsesRequest } = await import(
  "../../open-sse/translator/request/openai-responses/toResponses.ts"
);

const body = (assistant: Record<string, unknown>) => ({
  messages: [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      ...assistant,
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ],
});
const types = (r: any) => (r.input as Array<{ type: string }>).map((i) => i.type);

test("deepseek tool-call history without reasoning gets a placeholder reasoning item", () => {
  const r = openaiToOpenAIResponsesRequest("deepseek-v4-flash", body({}), false, {
    _provider: "deepseek",
  });
  const t = types(r);
  assert.ok(t.indexOf("reasoning") !== -1 && t.indexOf("reasoning") < t.indexOf("function_call"));
});

test("real reasoning is passed through; non-deepseek providers get no placeholder", () => {
  const real = openaiToOpenAIResponsesRequest(
    "deepseek-v4-flash",
    body({ reasoning_content: "thought" }),
    false,
    { _provider: "deepseek" }
  ) as any;
  assert.equal(real.input.find((i: any) => i.type === "reasoning").content[0].text, "thought");
  const other = openaiToOpenAIResponsesRequest("gpt-5", body({}), false, { _provider: "openai" });
  assert.ok(!types(other).includes("reasoning"));
});
