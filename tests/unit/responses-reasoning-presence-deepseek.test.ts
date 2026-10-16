import test from "node:test";
import assert from "node:assert/strict";

const { openaiToOpenAIResponsesRequest } =
  await import("../../open-sse/translator/request/openai-responses/toResponses.ts");
const { NON_ANTHROPIC_THINKING_PLACEHOLDER } =
  await import("../../open-sse/utils/reasoningPlaceholder.ts");

type InputItem = Record<string, unknown>;

function translate(
  model: string,
  body: unknown,
  credentials: unknown
): { input: InputItem[]; [key: string]: unknown } {
  return openaiToOpenAIResponsesRequest(model, body, true, credentials) as {
    input: InputItem[];
    [key: string]: unknown;
  };
}

const toolCallHistory = [
  { role: "user", content: "read the file" },
  {
    role: "assistant",
    content: "Reading it now.",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "ok" },
];

function reasoningIndexOf(input: InputItem[]): number {
  return input.findIndex((item) => item.type === "reasoning");
}
function functionCallIndexOf(input: InputItem[]): number {
  return input.findIndex((item) => item.type === "function_call");
}

// DeepSeek thinking mode 400s with "The reasoning_text in the thinking mode
// must be passed back to the API" when a tool-call turn reaches the Responses
// input with no preceding reasoning item — the reasoning-cache-miss case: the
// replay layer only supplies NON_ANTHROPIC_THINKING_PLACEHOLDER (or nothing),
// and internal placeholders never reach the real-reasoning push.
test("deepseek provider tool-call history without reasoning gets a reasoning item before function_call", () => {
  const { input } = translate(
    "deepseek-v4-flash",
    { messages: toolCallHistory },
    {
      _provider: "deepseek",
    }
  );

  const reasoningIdx = reasoningIndexOf(input);
  const functionCallIdx = functionCallIndexOf(input);
  assert.ok(reasoningIdx >= 0, "a reasoning item must precede the function_call");
  assert.ok(functionCallIdx >= 0, "function_call item present");
  assert.ok(
    reasoningIdx < functionCallIdx,
    `reasoning item must come before function_call (got reasoning@${reasoningIdx}, function_call@${functionCallIdx})`
  );

  const reasoningItem = input[reasoningIdx];
  assert.deepEqual(reasoningItem.content, [
    { type: "reasoning_text", text: NON_ANTHROPIC_THINKING_PLACEHOLDER },
  ]);
  assert.deepEqual(reasoningItem.summary, [], "reasoning items require a summary array");
  // Exactly one reasoning item — the placeholder is scaffolding, not history.
  assert.equal(
    input.filter((item) => item.type === "reasoning").length,
    1,
    "only one reasoning item may be injected per assistant turn"
  );
});

// Same shape, but the replay layer already injected the placeholder on the
// chat side (cache miss): it must be re-emitted as a reasoning item, not
// silently dropped as an internal placeholder.
test("a placeholder reasoning_content on the turn is re-emitted as a reasoning item", () => {
  const messages = [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      reasoning_content: NON_ANTHROPIC_THINKING_PLACEHOLDER,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ];

  const { input } = translate("deepseek-v4-flash", { messages }, { _provider: "deepseek" });

  const reasoningIdx = reasoningIndexOf(input);
  assert.ok(reasoningIdx >= 0, "placeholder reasoning must become a reasoning item");
  assert.ok(
    reasoningIdx < functionCallIndexOf(input),
    "reasoning item must come before function_call"
  );
  assert.deepEqual((input[reasoningIdx].content as InputItem[])[0], {
    type: "reasoning_text",
    text: NON_ANTHROPIC_THINKING_PLACEHOLDER,
  });
});

// Model-id matching without a threaded provider id (combo/registry paths).
test("a deepseek/mimo model id alone is enough to require the reasoning item", () => {
  for (const [model, credentials] of [
    ["deepseek-chat", null],
    ["xiaomi/mimo-v2.5-pro", null],
    ["mimo-v2.6-flash", { _provider: "xiaomi-mimo" }],
  ] as const) {
    const { input } = translate(model, { messages: toolCallHistory }, credentials);
    const reasoningIdx = reasoningIndexOf(input);
    assert.ok(reasoningIdx >= 0, `${model}: expected a reasoning item`);
    assert.ok(
      reasoningIdx < functionCallIndexOf(input),
      `${model}: reasoning item must come before function_call`
    );
  }
});

// Real reasoning is untouched: it passes through verbatim and no placeholder
// item is added alongside it.
test("real reasoning passes through verbatim with no placeholder item", () => {
  const realReasoning = "The user wants file contents; calling read_file.";
  const messages = [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "Reading it now.",
      reasoning_content: realReasoning,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ];

  const { input } = translate("deepseek-v4-flash", { messages }, { _provider: "deepseek" });

  const reasoningItems = input.filter((item) => item.type === "reasoning");
  assert.equal(reasoningItems.length, 1, "exactly one reasoning item");
  assert.deepEqual(reasoningItems[0].content, [{ type: "reasoning_text", text: realReasoning }]);
  assert.equal(
    input.some((item) => JSON.stringify(item).includes(NON_ANTHROPIC_THINKING_PLACEHOLDER)),
    false,
    "real reasoning must never be replaced by the placeholder"
  );
});

// Scope guard: providers that do not enforce reasoning presence must not gain
// a placeholder item (it would leak scaffolding into ordinary OpenAI traffic).
test('provider "openai" / gpt-5 gets no placeholder reasoning item', () => {
  const { input } = translate("gpt-5", { messages: toolCallHistory }, { _provider: "openai" });

  assert.equal(
    reasoningIndexOf(input),
    -1,
    "non-reasoning-presence providers must not receive an injected reasoning item"
  );
  assert.ok(functionCallIndexOf(input) >= 0, "the function_call item itself is still translated");
  assert.equal(
    input.some((item) => JSON.stringify(item).includes(NON_ANTHROPIC_THINKING_PLACEHOLDER)),
    false,
    "no placeholder may leak for providers that do not require reasoning presence"
  );
});

// Tool-call turns without reasoning on a non-reasoning provider stay unchanged
// even when the assistant history is empty of reasoning fields entirely.
test("assistant tool-call turn without reasoning on openai/gpt-5 keeps the plain message + function_call order", () => {
  const { input } = translate("gpt-5", { messages: toolCallHistory }, null);

  const types = input.map((item) => item.type);
  // user message, assistant message, function_call, tool output — and nothing
  // else: no reasoning item was injected.
  assert.deepEqual(types, ["message", "message", "function_call", "function_call_output"]);
});
