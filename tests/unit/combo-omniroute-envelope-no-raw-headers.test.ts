import { test, after } from "node:test";
import assert from "node:assert/strict";

const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const combo = await import("../../open-sse/services/combo.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

after(() => resetDbInstance());

function assertNoRawHeaders(value: unknown): void {
  assert.equal(value instanceof Headers, false, "body must not contain Headers");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /^(authorization|cookie|set-cookie|x-api-key)$/i);
    assertNoRawHeaders(child);
  }
}

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
  assert.doesNotThrow(() => structuredClone(body));
  assertNoRawHeaders(body);
  assert.deepEqual(structuredClone(body), body);
  assert.equal("_omnirouteHeaders" in body, false);
});

test("combo preserves an existing envelope and omits empty overrides", () => {
  const envelope = { taskRole: "implement" };
  const body = { _omnirouteEnvelope: envelope };
  combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-task-role": "review" }));
  assert.doesNotThrow(() => structuredClone(body));
  assert.deepEqual(body._omnirouteEnvelope, envelope);
  assert.notEqual(body._omnirouteEnvelope, envelope);
  const empty = {};
  combo.attachRequestRoutingEnvelope(empty, new Headers({ authorization: "Bearer x" }));
  assert.doesNotThrow(() => structuredClone(empty));
  assert.deepEqual(empty, {});
  assert.doesNotThrow(() => combo.attachRequestRoutingEnvelope(null, new Headers()));
  assert.doesNotThrow(() => structuredClone(null));
});

test("combo merges author controls with a body review envelope without mutation", () => {
  const envelope = Object.freeze({ taskRole: "review" });
  const body: Record<string, unknown> = { _omnirouteEnvelope: envelope };
  combo.attachRequestRoutingEnvelope(
    body,
    new Headers({
      "x-omniroute-author-model": "claude-sonnet-5-5",
      "x-omniroute-task-role": "implement",
    })
  );
  assert.deepEqual(body._omnirouteEnvelope, {
    taskRole: "review",
    authorModel: "claude-sonnet-5-5",
    excludeFamilies: ["claude-sonnet"],
  });
  assert.notEqual(body._omnirouteEnvelope, envelope);
  assert.deepEqual(envelope, { taskRole: "review" });
  assert.doesNotThrow(() => structuredClone(body));
  assertNoRawHeaders(body);
});

test("combo unions exclusions without duplicates or mutating the original list", () => {
  const envelope = { excludeFamilies: ["glm", "kimi"] };
  const body = { _omnirouteEnvelope: envelope };
  combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-exclude-family": "glm" }));
  assert.doesNotThrow(() => structuredClone(body));
  assert.deepEqual(body._omnirouteEnvelope.excludeFamilies, ["glm", "kimi"]);
  assert.notEqual(body._omnirouteEnvelope, envelope);
  assert.notEqual(body._omnirouteEnvelope.excludeFamilies, envelope.excludeFamilies);
  assert.deepEqual(envelope, { excludeFamilies: ["glm", "kimi"] });
});

test("combo replaces non-plain envelopes and omits an empty exclusion union", () => {
  for (const envelope of [null, [], "review", new Date(0), new Headers()]) {
    const body = { _omnirouteEnvelope: envelope };
    combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-task-role": "review" }));
    assert.doesNotThrow(() => structuredClone(body));
    assert.deepEqual(body._omnirouteEnvelope, { taskRole: "review" });
  }
  const body = { _omnirouteEnvelope: { excludeFamilies: [] } };
  combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-task-role": "review" }));
  assert.doesNotThrow(() => structuredClone(body));
  assert.deepEqual(body._omnirouteEnvelope, { taskRole: "review" });
});

test("combo keeps header values when body overrides are undefined", () => {
  const body = { _omnirouteEnvelope: { taskRole: undefined } };
  combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-task-role": "review" }));
  assert.doesNotThrow(() => structuredClone(body));
  assert.deepEqual(body._omnirouteEnvelope, { taskRole: "review" });
});

test("combo ignores non-array body exclusions without cancelling header exclusions", () => {
  for (const excludeFamilies of [null, "kimi", {}, 1]) {
    const body = { _omnirouteEnvelope: { excludeFamilies } };
    assert.doesNotThrow(() =>
      combo.attachRequestRoutingEnvelope(body, new Headers({ "x-omniroute-exclude-family": "glm" }))
    );
    assert.doesNotThrow(() => structuredClone(body));
    assert.deepEqual(body._omnirouteEnvelope, { excludeFamilies: ["glm"] });
  }
});

test("combo drops non-plain envelopes even without header overrides", () => {
  for (const envelope of [new Headers(), new Date(0), [], "review", null]) {
    for (const headers of [new Headers(), undefined]) {
      const body = { _omnirouteEnvelope: envelope };
      combo.attachRequestRoutingEnvelope(body, headers);
      assert.doesNotThrow(() => structuredClone(body));
      assert.equal("_omnirouteEnvelope" in body, false);
    }
  }
});

test("raw header assertion rejects nested credentials and Headers", () => {
  for (const key of ["Authorization", "COOKIE", "Set-Cookie", "X-Api-Key"]) {
    assert.throws(() => assertNoRawHeaders({ nested: [{ [key]: "example" }] }));
  }
  assert.throws(() => assertNoRawHeaders({ nested: new Headers() }));
});
