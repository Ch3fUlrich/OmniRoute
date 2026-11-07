import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const tokens = await import("../../src/lib/db/accessTokens.ts");
const route = await import("../../src/app/api/usage/call-logs/route.ts");

test.before(async () => {
  await settings.updateSettings({ requireLogin: false });
  const insert = core.getDbInstance().prepare(
    `INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, detail_state)
     VALUES (?, ?, 'POST', '/v1/chat/completions', 200, 'test-model', 'test-provider', 'none')`
  );
  for (let i = 0; i < 205; i++) insert.run(`cap-${i}`, new Date().toISOString());
});

test.after(() => core.resetDbInstance());

async function count(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const response = await route.GET(
    new Request("http://localhost/api/usage/call-logs?limit=205", { headers })
  );
  assert.equal(response.status, 200);
  return (await response.json()).length;
}

test("unverified token-prefixed Bearer is capped even when management auth accepts open mode", async () => {
  const token = tokens.createAccessToken({ name: "revoked", scope: "read" });
  core
    .getDbInstance()
    .prepare("UPDATE cli_access_tokens SET revoked_at = ? WHERE id = ?")
    .run(new Date().toISOString(), token.record.id);
  assert.equal(await count(token.secret), route.LIMITED_SCOPE_CALL_LOGS_MAX_LIMIT);
});

test("valid logs:read token is capped", async () => {
  const token = tokens.createAccessToken({
    name: "limited",
    scope: "logs:read",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await count(token.secret), route.LIMITED_SCOPE_CALL_LOGS_MAX_LIMIT);
});

test("full-scope token and management open-mode caller are not capped", async () => {
  const token = tokens.createAccessToken({ name: "full", scope: "read" });
  assert.equal(await count(token.secret), 205);
  assert.equal(await count(), 205);
});
