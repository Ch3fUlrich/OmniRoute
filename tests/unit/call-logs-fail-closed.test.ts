import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

process.env.JWT_SECRET = "unit-test-session-signing-key-only";
process.env.INITIAL_PASSWORD = "unit-test-auth-required-only";

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
test.beforeEach(async () => settings.updateSettings({ requireLogin: false }));

function revokedToken() {
  const token = tokens.createAccessToken({ name: "revoked-pin", scope: "read" });
  core
    .getDbInstance()
    .prepare("UPDATE cli_access_tokens SET revoked_at = ? WHERE id = ?")
    .run(new Date().toISOString(), token.record.id);
  return token.secret;
}

for (const [label, header] of [
  ["lower-case bearer", (secret: string) => `bearer ${secret}`],
  ["extra bearer whitespace", (secret: string) => `  Bearer   ${secret}  `],
] as const) {
  test(`revoked token is capped with ${label} in open mode`, async () => {
    const response = await route.GET(
      new Request("http://localhost/api/usage/call-logs?limit=205", {
        headers: { authorization: header(revokedToken()) },
      })
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, route.LIMITED_SCOPE_CALL_LOGS_MAX_LIMIT);
  });
}

test("logs:read token in x-api-key is rejected by management API-key auth", async () => {
  await settings.updateSettings({ requireLogin: true });
  const token = tokens.createAccessToken({
    name: "header-pin",
    scope: "logs:read",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const response = await route.GET(
    new Request("http://localhost/api/usage/call-logs?limit=205", {
      headers: { "x-api-key": token.secret },
    })
  );
  assert.equal(response.status, 401);
  assert.ok(!Array.isArray(await response.json()));
});

test("URL token never authenticates call-log management requests", async () => {
  await settings.updateSettings({ requireLogin: true });
  const token = tokens.createAccessToken({ name: "query-pin", scope: "read" });
  const response = await route.GET(
    new Request(`http://localhost/api/usage/call-logs?limit=205&token=${token.secret}`)
  );
  assert.equal(response.status, 401);
  assert.ok(!Array.isArray(await response.json()));
});

test("verification DB exception returns 500 without rows", async (t) => {
  const secret = revokedToken();
  const db = core.getDbInstance();
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("cli_access_tokens")) throw new Error("unit verification DB failure");
    return prepare(sql);
  });
  const response = await route.GET(
    new Request("http://localhost/api/usage/call-logs?limit=205", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
  assert.equal(response.status, 500);
  assert.ok(!Array.isArray(await response.json()));
});

test("valid dashboard session plus stale bearer remains capped intentionally", async () => {
  await settings.updateSettings({ requireLogin: true });
  const session = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  // Fail closed on the supplied machine credential even when the session grants access.
  const response = await route.GET(
    new Request("http://localhost/api/usage/call-logs?limit=205", {
      headers: { cookie: `auth_token=${session}`, authorization: `Bearer ${revokedToken()}` },
    })
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, route.LIMITED_SCOPE_CALL_LOGS_MAX_LIMIT);
});

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
