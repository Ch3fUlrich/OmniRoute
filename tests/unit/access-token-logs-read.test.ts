import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-logs-read-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "test-management-password";
process.env.API_KEY_SECRET = "test-api-key-secret";
process.env.ALLOW_API_KEY_REVEAL = "true";

const core = await import("../../src/lib/db/core.ts");
const scopesModule = await import("../../src/lib/accessTokens/scopes.ts");
const accessTokensDb = await import("../../src/lib/db/accessTokens.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { requireManagementAuth } = await import("../../src/lib/api/requireManagementAuth.ts");
const callLogsRoute = await import("../../src/app/api/usage/call-logs/route.ts");
const tokensRoute = await import("../../src/app/api/cli/tokens/route.ts");
const revealRoute = await import("../../src/app/api/keys/[id]/reveal/route.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");

const BASE = "http://localhost:20128";

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    apiKeysDb.resetApiKeyState?.();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  delete process.env.INITIAL_PASSWORD;
  delete process.env.API_KEY_SECRET;
  delete process.env.ALLOW_API_KEY_REVEAL;
});

test("LIMITED_SCOPES contains 'logs:read' and scopeSatisfies('logs:read', any) is false", () => {
  assert.deepEqual([...scopesModule.LIMITED_SCOPES], ["logs:read"]);
  assert.deepEqual([...scopesModule.ACCESS_SCOPES], ["read", "write", "admin"]);

  // logs:read satisfies nothing
  assert.equal(scopesModule.scopeSatisfies("logs:read", "read"), false);
  assert.equal(scopesModule.scopeSatisfies("logs:read", "write"), false);
  assert.equal(scopesModule.scopeSatisfies("logs:read", "admin"), false);

  // hierarchy scopes do not satisfy logs:read
  assert.equal(scopesModule.scopeSatisfies("read", "logs:read" as unknown as scopesModule.AccessScope), false);
  assert.equal(scopesModule.scopeSatisfies("write", "logs:read" as unknown as scopesModule.AccessScope), false);
  assert.equal(scopesModule.scopeSatisfies("admin", "logs:read" as unknown as scopesModule.AccessScope), false);
});

test("createAccessToken stores 'logs:read' without widening, verifyAccessToken returns 'logs:read'", () => {
  const { record, secret } = accessTokensDb.createAccessToken({
    name: "plangraph-test-1",
    scope: "logs:read",
  });
  assert.equal(record.scope, "logs:read");

  const verified = accessTokensDb.verifyAccessToken(secret);
  assert.ok(verified);
  assert.equal(verified?.scope, "logs:read");

  const listed = accessTokensDb.listAccessTokens().find((t) => t.id === record.id);
  assert.ok(listed);
  assert.equal(listed?.scope, "logs:read");
});

test("stored unknown scope yields no access (invalid), never 'read'", () => {
  const { record, secret } = accessTokensDb.createAccessToken({
    name: "tampered-token",
    scope: "read",
  });
  const db = core.getDbInstance();
  db.prepare("UPDATE cli_access_tokens SET scope = ? WHERE id = ?").run("unknown_scope", record.id);

  // verifyAccessToken must return null (invalid / no access)
  const verified = accessTokensDb.verifyAccessToken(secret);
  assert.equal(verified, null);

  // When used on a route, it gets 401
  const req = new Request(`${BASE}/api/usage/call-logs`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const authErr = requireManagementAuth(req);
  return Promise.resolve(authErr).then((res) => {
    assert.ok(res);
    assert.equal(res?.status, 401);
  });
});

test("POST /api/cli/tokens validates scope 'logs:read' and expiresInMinutes", async () => {
  const admin = accessTokensDb.createAccessToken({ name: "admin-for-minting", scope: "admin" });

  // 1. Success with expiresInMinutes
  const reqOk = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${admin.secret}`,
    },
    body: JSON.stringify({
      name: "plangraph-job-123",
      scope: "logs:read",
      expiresInMinutes: 30,
    }),
  });
  const resOk = await tokensRoute.POST(reqOk);
  assert.equal(resOk.status, 200);
  const dataOk = await resOk.json();
  assert.equal(dataOk.scope, "logs:read");
  assert.ok(dataOk.token.startsWith("oma_live_"));
  assert.ok(dataOk.expiresAt);
  const diffMs = new Date(dataOk.expiresAt).getTime() - Date.now();
  assert.ok(diffMs > 28 * 60_000 && diffMs <= 30 * 60_000 + 1000);

  // 2. Reject both expiresInDays and expiresInMinutes together (400)
  const reqBoth = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${admin.secret}`,
    },
    body: JSON.stringify({
      name: "both-expiries",
      scope: "logs:read",
      expiresInDays: 1,
      expiresInMinutes: 30,
    }),
  });
  const resBoth = await tokensRoute.POST(reqBoth);
  assert.equal(resBoth.status, 400);

  // 3. Reject expiresInMinutes out of bounds (< 1 or > 1440)
  const reqZero = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${admin.secret}`,
    },
    body: JSON.stringify({
      name: "zero-minutes",
      expiresInMinutes: 0,
    }),
  });
  assert.equal((await tokensRoute.POST(reqZero)).status, 400);

  const reqTooLarge = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${admin.secret}`,
    },
    body: JSON.stringify({
      name: "too-many-minutes",
      expiresInMinutes: 1441,
    }),
  });
  assert.equal((await tokensRoute.POST(reqTooLarge)).status, 400);
});

test("logs:read scope access matrix: 200 on GET /api/usage/call-logs; 403 on reveal, tokens, other GET, POST call-logs; 401 on expired", async () => {
  featureFlagsDb.setFeatureFlagOverride("ALLOW_API_KEY_REVEAL", "true");
  const testKey = await apiKeysDb.createApiKey("reveal-target", "machine-test");

  const { secret } = accessTokensDb.createAccessToken({
    name: "plangraph-token",
    scope: "logs:read",
  });

  // 1. GET /api/usage/call-logs -> 200
  const reqLogs = new Request(`${BASE}/api/usage/call-logs?limit=5`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resLogs = await callLogsRoute.GET(reqLogs);
  assert.equal(resLogs.status, 200);

  // 2. GET /api/keys/<id>/reveal (reveal enabled) -> 403
  const reqReveal = new Request(`${BASE}/api/keys/${testKey.id}/reveal`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resReveal = await revealRoute.GET(reqReveal, { params: Promise.resolve({ id: testKey.id }) });
  assert.equal(resReveal.status, 403);

  // 3. GET /api/cli/tokens -> 403
  const reqTokens = new Request(`${BASE}/api/cli/tokens`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resTokens = await tokensRoute.GET(reqTokens);
  assert.equal(resTokens.status, 403);

  // 4. Another GET management route (e.g. GET /api/v1/models or GET /api/combos) -> 403
  const reqCombos = new Request(`${BASE}/api/combos`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resCombos = await requireManagementAuth(reqCombos);
  assert.ok(resCombos);
  assert.equal(resCombos?.status, 403);

  // 5. POST /api/usage/call-logs -> 403
  const reqPostLogs = new Request(`${BASE}/api/usage/call-logs`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  const resPostLogs = await requireManagementAuth(reqPostLogs);
  assert.ok(resPostLogs);
  assert.equal(resPostLogs?.status, 403);

  // 6. Expired token (minutes in the past) -> 401
  const past = new Date(Date.now() - 60_000).toISOString();
  const { secret: expiredSecret } = accessTokensDb.createAccessToken({
    name: "expired-minutes-tok",
    scope: "logs:read",
    expiresAt: past,
  });
  const reqExp = new Request(`${BASE}/api/usage/call-logs`, {
    headers: { authorization: `Bearer ${expiredSecret}` },
  });
  const resExp = await callLogsRoute.GET(reqExp);
  assert.equal(resExp.status, 401);
});
