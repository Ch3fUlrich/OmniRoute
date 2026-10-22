import { test, after } from "node:test";
import assert from "node:assert/strict";

const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const combo = await import("../../open-sse/services/combo.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

after(() => resetDbInstance());

test("OpenAI upstream bodies discard internal fields before cloning real Headers", async () => {
  const headers = new Headers({
    authorization: "Bearer x",
    "x-omniroute-task-role": "review",
  });
  const translatedBody = {
    messages: [{ role: "user", content: "hi" }],
    _omnirouteHeaders: headers,
    _omnirouteEnvelope: { taskRole: "review" },
    _omnirouteUncloneable: () => undefined,
  };
  const result = await prepareUpstreamBody({
    translatedBody,
    modelToCall: "local-model",
    provider: "openai-compatible-local",
    targetFormat: "openai",
    credentials: {},
  });
  assert.equal(
    Object.keys(result).some((key) => key.startsWith("_omniroute")),
    false
  );
  assert.deepEqual(result.messages, translatedBody.messages);
  assert.equal(translatedBody._omnirouteHeaders, headers);
});

test("combo carries only parsed plain routing overrides, never raw credentials", () => {
  const body: Record<string, unknown> = { messages: [] };
  combo.attachRequestRoutingEnvelope(
    body,
    new Headers({
      authorization: "Bearer x",
      cookie: "example=value",
      "x-omniroute-task-role": "review",
    })
  );
  assert.deepEqual(body._omnirouteEnvelope, { taskRole: "review" });
  assert.deepEqual(structuredClone(body), body);
  assert.doesNotMatch(JSON.stringify(body), /authorization|cookie|Bearer/);
  assert.equal("_omnirouteHeaders" in body, false);
});

test("combo preserves an existing envelope and omits empty overrides", () => {
  const envelope = { taskRole: "implement" };
  const body = { _omnirouteEnvelope: envelope };
  combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-task-role": "review" }));
  assert.equal(body._omnirouteEnvelope, envelope);
  const empty = {};
  combo.attachRequestRoutingEnvelope(empty, new Headers({ authorization: "Bearer x" }));
  assert.deepEqual(empty, {});
  assert.doesNotThrow(() => combo.attachRequestRoutingEnvelope(null, new Headers()));
});
