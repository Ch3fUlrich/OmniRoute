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
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const callLogsRoute = await import("../../src/app/api/usage/call-logs/route.ts");
const tokensRoute = await import("../../src/app/api/cli/tokens/route.ts");
const revealRoute = await import("../../src/app/api/keys/[id]/reveal/route.ts");
const whoamiRoute = await import("../../src/app/api/cli/whoami/route.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");

const BASE = "http://localhost:20128";

const OPERATOR_CLI_HEADERS = {
  "x-omniroute-auth-kind": "management_key",
  "x-omniroute-auth-label": "local-cli-token",
};

function validExpiryIso(minutes = 30): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    apiKeysDb.resetApiKeyState?.();
  } catch {}
  try {
    featureFlagsDb.removeFeatureFlagOverride("ALLOW_API_KEY_REVEAL");
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
  assert.equal(
    scopesModule.scopeSatisfies("read", "logs:read" as unknown as scopesModule.AccessScope),
    false
  );
  assert.equal(
    scopesModule.scopeSatisfies("write", "logs:read" as unknown as scopesModule.AccessScope),
    false
  );
  assert.equal(
    scopesModule.scopeSatisfies("admin", "logs:read" as unknown as scopesModule.AccessScope),
    false
  );
});

test("F-2 / F-9: createAccessToken requires expiresAt for limited scopes and preserves TokenScope", () => {
  // F-2: Limited scope without expiresAt must throw
  assert.throws(
    () => {
      accessTokensDb.createAccessToken({
        name: "unbounded-logs-token",
        scope: "logs:read",
      });
    },
    /expiration/i,
    "createAccessToken must throw when minting limited scope without expiresAt"
  );

  // Succeeds with expiresAt
  const { record, secret } = accessTokensDb.createAccessToken({
    name: "plangraph-test-1",
    scope: "logs:read",
    expiresAt: validExpiryIso(30),
  });
  assert.equal(record.scope, "logs:read");

  const verified = accessTokensDb.verifyAccessToken(secret);
  assert.ok(verified);
  assert.equal(verified?.scope, "logs:read");

  const listed = accessTokensDb.listAccessTokens().find((t) => t.id === record.id);
  assert.ok(listed);
  assert.equal(listed?.scope, "logs:read");
});

test("F-3: LIMITED_SCOPE_GRANTS structure maps each grant to an existing api route file", () => {
  assert.ok(scopesModule.LIMITED_SCOPE_GRANTS, "LIMITED_SCOPE_GRANTS must be exported");
  const grants = (
    scopesModule.LIMITED_SCOPE_GRANTS as Record<
      string,
      ReadonlyArray<{ method: string; path: string }>
    >
  )["logs:read"];
  assert.ok(Array.isArray(grants), "grants for logs:read must be an array");

  for (const grant of grants) {
    assert.ok(grant.method, "grant must specify method");
    assert.ok(grant.path, "grant must specify path");
    // Normalize path to file system: /api/usage/call-logs -> src/app/api/usage/call-logs/route.ts
    const relativePath = grant.path.replace(/^\//, "");
    const expectedRouteFile = path.resolve(process.cwd(), "src/app", relativePath, "route.ts");
    assert.ok(
      fs.existsSync(expectedRouteFile),
      `Grant path ${grant.path} must resolve to an existing route file (${expectedRouteFile})`
    );
  }
});

test("F-6: stored unknown scope yields no access (invalid), logs a warning with id/prefix only, and rowToRecord agrees", async () => {
  const { record, secret } = accessTokensDb.createAccessToken({
    name: "tampered-token",
    scope: "read",
  });
  const db = core.getDbInstance();
  db.prepare("UPDATE cli_access_tokens SET scope = ? WHERE id = ?").run("unknown_scope", record.id);

  // Capture console.warn to verify warning breadcrumb
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    // verifyAccessToken must return null (invalid / no access)
    const verified = accessTokensDb.verifyAccessToken(secret);
    assert.equal(verified, null);

    // F-6: Must have logged a warning mentioning id and prefix, but NOT the secret
    assert.ok(warnings.length > 0, "must log a warning when stored scope is unknown");
    const warnMessage = warnings.join("\n");
    assert.match(warnMessage, new RegExp(record.id));
    assert.match(warnMessage, new RegExp(record.tokenPrefix));
    assert.equal(warnMessage.includes(secret), false, "must never log token secret");
  } finally {
    console.warn = originalWarn;
  }

  // rowToRecord (via getAccessToken and listAccessTokens) must NOT coerce to "read", must keep raw value
  const fetched = accessTokensDb.getAccessToken(record.id);
  assert.ok(fetched);
  assert.equal(
    fetched.scope,
    "unknown_scope",
    "getAccessToken must not coerce unknown scope to 'read'"
  );

  const listed = accessTokensDb.listAccessTokens().find((t) => t.id === record.id);
  assert.ok(listed);
  assert.equal(
    listed.scope,
    "unknown_scope",
    "listAccessTokens must not coerce unknown scope to 'read'"
  );

  // When used on a route, it gets 401
  const req = new Request(`${BASE}/api/usage/call-logs`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const authErr = await requireManagementAuth(req);
  assert.ok(authErr);
  assert.equal(authErr?.status, 401);
});

test("POST /api/cli/tokens validates scope 'logs:read' and expiresInMinutes", async () => {
  const admin = accessTokensDb.createAccessToken({ name: "admin-for-minting", scope: "admin" });

  // 1. Admin oma_ token (machine credential) cannot mint logs:read -> 403
  const reqMachine = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${admin.secret}`,
    },
    body: JSON.stringify({
      name: "machine-minted-limited",
      scope: "logs:read",
      expiresInMinutes: 30,
    }),
  });
  const resMachine = await tokensRoute.POST(reqMachine);
  assert.equal(resMachine.status, 403, "machine oma_ token cannot mint logs:read");

  // F-7 (a): Manage-scope API key (machine credential) cannot mint logs:read -> 403
  const manageKey = await apiKeysDb.createApiKey("machine-manage-key", "manage-admin-key", [
    "manage",
  ]);
  const reqManageKey = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${manageKey.key}`,
    },
    body: JSON.stringify({
      name: "machine-apikey-minted-limited",
      scope: "logs:read",
      expiresInMinutes: 30,
    }),
  });
  const resManageKey = await tokensRoute.POST(reqManageKey);
  assert.equal(
    resManageKey.status,
    403,
    "manage-scope API key machine credential cannot mint logs:read"
  );

  // 2. Operator minting logs:read without expiresInMinutes is rejected -> 400
  const reqNoExpiry = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...OPERATOR_CLI_HEADERS,
    },
    body: JSON.stringify({
      name: "no-expiry-limited",
      scope: "logs:read",
    }),
  });
  const resNoExpiry = await tokensRoute.POST(reqNoExpiry);
  assert.equal(resNoExpiry.status, 400, "logs:read mint without expiresInMinutes must return 400");

  // 3. Operator minting logs:read with expiresInDays is rejected -> 400
  const reqDaysOnly = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...OPERATOR_CLI_HEADERS,
    },
    body: JSON.stringify({
      name: "days-expiry-limited",
      scope: "logs:read",
      expiresInDays: 1,
    }),
  });
  const resDaysOnly = await tokensRoute.POST(reqDaysOnly);
  assert.equal(resDaysOnly.status, 400, "logs:read mint with expiresInDays must return 400");

  // 4. Operator minting logs:read with expiresInMinutes succeeds -> 200
  const reqOk = new Request(`${BASE}/api/cli/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...OPERATOR_CLI_HEADERS,
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
});

test("logs:read scope access matrix: 200 on call-logs (including trailing slash & relative URL) & whoami; 403 on reveal, tokens, adjacent surfaces, HEAD; 401 on expired", async () => {
  featureFlagsDb.setFeatureFlagOverride("ALLOW_API_KEY_REVEAL", "true");
  const testKey = await apiKeysDb.createApiKey("reveal-target", "machine-test");

  const { secret } = accessTokensDb.createAccessToken({
    name: "plangraph-token",
    scope: "logs:read",
    expiresAt: validExpiryIso(60),
  });

  // 1. GET /api/usage/call-logs -> 200
  const reqLogs = new Request(`${BASE}/api/usage/call-logs?limit=5`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resLogs = await callLogsRoute.GET(reqLogs);
  assert.equal(resLogs.status, 200);

  // F-4: Unbounded bulk read capped for limited scope (requested limit 500 capped to 200)
  const reqBulkLogs = new Request(`${BASE}/api/usage/call-logs?limit=500`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resBulkLogs = await callLogsRoute.GET(reqBulkLogs);
  assert.equal(resBulkLogs.status, 200);
  const rows = await resBulkLogs.json();
  assert.ok(Array.isArray(rows));
  assert.ok(
    rows.length <= 200,
    `limited scope logs rows count ${rows.length} must be capped at 200`
  );

  // F-5: Relative URL GET /api/usage/call-logs -> 200
  const reqRelative = {
    method: "GET",
    url: "/api/usage/call-logs",
    headers: new Headers({ authorization: `Bearer ${secret}` }),
  } as unknown as Request;
  const resRelative = await requireManagementAuth(reqRelative);
  assert.equal(resRelative, null, "relative URL /api/usage/call-logs must be allowed");

  // F-5: Trailing slash GET /api/usage/call-logs/ -> 200 (normalized like classifier)
  const reqTrailing = new Request(`${BASE}/api/usage/call-logs/`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resTrailing = await requireManagementAuth(reqTrailing);
  assert.equal(
    resTrailing,
    null,
    "trailing slash /api/usage/call-logs/ must normalize and be allowed"
  );

  // 2. Sibling path GET /api/usage/call-logs/filters -> 403
  const reqFilters = new Request(`${BASE}/api/usage/call-logs/filters`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resFilters = await requireManagementAuth(reqFilters);
  assert.ok(resFilters);
  assert.equal(resFilters?.status, 403, "sibling /api/usage/call-logs/filters must be 403");

  // 3. Sibling path GET /api/usage/call-logs/<id> -> 403
  const reqId = new Request(`${BASE}/api/usage/call-logs/call-item-abc-123`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resId = await requireManagementAuth(reqId);
  assert.ok(resId);
  assert.equal(resId?.status, 403, "sibling /api/usage/call-logs/<id> must be 403");

  // 5. Case variant GET /API/USAGE/CALL-LOGS -> 403
  const reqCase = new Request(`${BASE}/API/USAGE/CALL-LOGS`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resCase = await requireManagementAuth(reqCase);
  assert.ok(resCase);
  assert.equal(resCase?.status, 403, "case variant /API/USAGE/CALL-LOGS must be 403");

  // 6. HEAD /api/usage/call-logs -> 403
  const reqHead = new Request(`${BASE}/api/usage/call-logs`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${secret}` },
  });
  const resHead = await requireManagementAuth(reqHead);
  assert.ok(resHead);
  assert.equal(resHead?.status, 403, "HEAD /api/usage/call-logs must be 403");

  // F-1: GET /api/cli/whoami with logs:read -> 200 (usable by connect --key)
  const reqWhoami = new Request(`${BASE}/api/cli/whoami`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resWhoami = await whoamiRoute.GET(reqWhoami);
  assert.equal(resWhoami.status, 200, "GET /api/cli/whoami with logs:read must return 200");
  const whoamiBody = await resWhoami.json();
  assert.equal(whoamiBody.authenticated, true);
  assert.equal(whoamiBody.viaAccessToken, true);
  assert.equal(whoamiBody.scope, "logs:read");

  // 8. GET /api/keys/<id>/reveal (reveal enabled) -> 403
  const reqReveal = new Request(`${BASE}/api/keys/${testKey.id}/reveal`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resReveal = await revealRoute.GET(reqReveal, {
    params: Promise.resolve({ id: testKey.id }),
  });
  assert.equal(resReveal.status, 403);

  // 9. GET /api/cli/tokens -> 403
  const reqTokens = new Request(`${BASE}/api/cli/tokens`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resTokens = await tokensRoute.GET(reqTokens);
  assert.equal(resTokens.status, 403);

  // 10. Another GET management route (e.g. GET /api/combos) -> 403
  const reqCombos = new Request(`${BASE}/api/combos`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const resCombos = await requireManagementAuth(reqCombos);
  assert.ok(resCombos);
  assert.equal(resCombos?.status, 403);

  // F-7 (c): Assert logs:read is refused on richer adjacent surfaces
  for (const adjacentPath of [
    "/api/logs",
    "/api/logs/export",
    "/api/usage/request-logs",
    "/api/conversations",
  ]) {
    const adjacentReq = new Request(`${BASE}${adjacentPath}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    const adjacentRes = await requireManagementAuth(adjacentReq);
    assert.ok(adjacentRes, `expected rejection on adjacent surface ${adjacentPath}`);
    assert.equal(adjacentRes?.status, 403, `adjacent surface ${adjacentPath} must be 403`);
  }

  // 11. POST /api/usage/call-logs -> 403
  const reqPostLogs = new Request(`${BASE}/api/usage/call-logs`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  const resPostLogs = await requireManagementAuth(reqPostLogs);
  assert.ok(resPostLogs);
  assert.equal(resPostLogs?.status, 403);

  // 12. Expired token (minutes in the past) -> 401
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

test("F-7 (b): Authoritative central gate managementPolicy allows logs:read on call-logs and rejects other management routes", async () => {
  const { secret } = accessTokensDb.createAccessToken({
    name: "policy-test-token",
    scope: "logs:read",
    expiresAt: validExpiryIso(30),
  });

  // Policy context helper
  function makePolicyCtx(pathname: string, method = "GET") {
    return {
      request: {
        method,
        headers: new Headers({ authorization: `Bearer ${secret}` }),
        url: `http://localhost${pathname}`,
        nextUrl: { pathname },
      },
      classification: {
        routeClass: "MANAGEMENT" as const,
        reason: "management_api" as const,
        normalizedPath: pathname,
      },
      requestId: "req_policy_test",
    } as unknown as Parameters<typeof managementPolicy.evaluate>[0];
  }

  // Allowed on call-logs
  const outcomeOk = await managementPolicy.evaluate(makePolicyCtx("/api/usage/call-logs"));
  assert.equal(outcomeOk.allow, true);
  if (outcomeOk.allow) {
    assert.equal(outcomeOk.subject.kind, "management_key");
    assert.equal(outcomeOk.subject.label, "access-token:logs:read");
  }

  // Rejected on /api/settings
  const outcomeDenied = await managementPolicy.evaluate(makePolicyCtx("/api/settings"));
  assert.equal(outcomeDenied.allow, false);
  if (!outcomeDenied.allow) {
    assert.equal(outcomeDenied.status, 403);
    assert.equal(outcomeDenied.code, "AUTH_SCOPE");
  }
});
