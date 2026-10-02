/**
 * Async-job routes: POST /api/async-jobs (create), GET /api/async-jobs/{jobId} (poll) and the
 * public, token-gated POST /api/async-callbacks/{jobId}.
 *
 * Covers: management auth on create/poll; the token is shown once and never read back; the
 * callback authenticates by token BEFORE it reads any body (a wrong token with an oversized or
 * malformed body still answers 401, unknown job and wrong token answer alike); strict body
 * validation; the 256 KiB cap on declared and streamed size; the per-job rate limit; the
 * pending -> running -> completed path; a late callback gets 409 plus one names-only log line;
 * error bodies never leak stack text; the callback prefix is public and the creator routes are not.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { setupSettingsFixture } from "../_mocks/settings.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const fixture = setupSettingsFixture("async-jobs-routes");
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "test-jwt-secret-async-jobs";
process.env.INITIAL_PASSWORD = "initial-pass-async-jobs";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const runtime = await import("../../../src/lib/config/runtimeSettings.ts");
const rateLimiter = await import("../../../src/shared/utils/rateLimiter.ts");
const { logger } = await import("../../../src/shared/utils/logger.ts");
const jobsDb = await import("../../../src/lib/db/asyncJobs.ts");
const publicRoutes = await import("../../../src/shared/constants/publicApiRoutes.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const createRoute = await import("../../../src/app/api/async-jobs/route.ts");
const pollRoute = await import("../../../src/app/api/async-jobs/[jobId]/route.ts");
const callbackRoute = await import("../../../src/app/api/async-callbacks/[jobId]/route.ts");

rateLimiter.setRateLimiterTestMode(true);

test.beforeEach(async () => {
  await fixture.resetStorage();
  runtime.resetRuntimeSettingsStateForTests();
  rateLimiter.setRateLimiterTestMode(true);
  await settingsDb.updateSettings({ requireLogin: true });
});

test.after(() => {
  core.resetDbInstance();
  fixture.cleanup();
});

const BASE = "http://localhost";

type JobBody = {
  job: { id: string; status: string; kind: string; result: string | null; error: string | null };
  reused?: boolean;
  callback?: { path: string; header: string; token: string };
};

async function createJob(body: Record<string, unknown> = {}) {
  const request = await makeManagementSessionRequest(`${BASE}/api/async-jobs`, {
    method: "POST",
    body,
  });
  const response = await createRoute.POST(request);
  return { response, json: (await response.json()) as JobBody };
}

function callbackRequest(
  jobId: string,
  token: string | null,
  body: unknown,
  init: RequestInit = {}
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("X-Callback-Token", token);
  return new Request(`${BASE}/api/async-callbacks/${jobId}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

async function poll(jobId: string) {
  const request = await makeManagementSessionRequest(`${BASE}/api/async-jobs/${jobId}`);
  const response = await pollRoute.GET(request, ctx(jobId));
  return { response, json: (await response.json()) as JobBody };
}

test("create: needs management auth", async () => {
  const response = await createRoute.POST(
    new Request(`${BASE}/api/async-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  assert.ok([401, 403].includes(response.status), `status ${response.status}`);
});

test("create: 201 with the callback path, header name and a one-time token", async () => {
  const { response, json } = await createJob({ kind: "unit", metadata: { a: 1 } });
  assert.equal(response.status, 201);
  assert.equal(json.reused, false);
  assert.equal(json.job.status, "pending");
  assert.equal(json.job.kind, "unit");
  assert.equal(json.callback.path, `/api/async-callbacks/${json.job.id}`);
  assert.equal(json.callback.header, "X-Callback-Token");
  assert.match(json.callback.token, /^[0-9a-f]{64}$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("create: an identical idempotency key returns the same job without a second token", async () => {
  const first = await createJob({ idempotencyKey: "abc" });
  const again = await createJob({ idempotencyKey: "abc" });
  assert.equal(again.response.status, 200);
  assert.equal(again.json.reused, true);
  assert.equal(again.json.job.id, first.json.job.id);
  assert.equal(again.json.callback, undefined);
});

test("create: invalid bodies are 400 (unknown field, bad ttl, bad kind, oversized metadata, bad JSON)", async () => {
  for (const body of [
    { nope: 1 },
    { ttlSeconds: 5 },
    { ttlSeconds: 999_999 },
    { kind: "has space" },
    { metadata: { big: "x".repeat(5000) } },
  ]) {
    const { response } = await createJob(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const bad = await createRoute.POST(
    await makeManagementSessionRequest(`${BASE}/api/async-jobs`, { method: "POST", body: "{nope" })
  );
  assert.equal(bad.status, 400);
});

test("poll: needs management auth; 404 for an unknown job; never shows the token or its hash", async () => {
  const created = await createJob();
  const anonymous = await pollRoute.GET(
    new Request(`${BASE}/api/async-jobs/${created.json.job.id}`),
    ctx(created.json.job.id)
  );
  assert.ok([401, 403].includes(anonymous.status));

  const missing = await poll("00000000-0000-0000-0000-000000000000");
  assert.equal(missing.response.status, 404);

  const { response, json } = await poll(created.json.job.id);
  assert.equal(response.status, 200);
  assert.equal(json.job.status, "pending");
  const text = JSON.stringify(json);
  assert.equal(text.includes(created.json.callback.token), false);
  assert.equal(text.includes("token_hash"), false);
  assert.equal(text.includes("tokenHash"), false);
});

test("callback: missing or wrong token is 401 and an unknown job answers the same", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const missing = await callbackRoute.POST(
    callbackRequest(id, null, { status: "completed" }),
    ctx(id)
  );
  const wrong = await callbackRoute.POST(
    callbackRequest(id, "0".repeat(64), { status: "completed" }),
    ctx(id)
  );
  const unknown = await callbackRoute.POST(
    callbackRequest("no-such-job", json.callback.token, { status: "completed" }),
    ctx("no-such-job")
  );
  for (const r of [missing, wrong, unknown]) assert.equal(r.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal((await poll(id)).json.job.status, "pending");
});

test("callback: the token is checked BEFORE the body is read (huge or malformed body + bad token = 401)", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const huge = await callbackRoute.POST(
    callbackRequest(id, "bad", "x".repeat(300 * 1024), {
      headers: { "content-type": "application/json", "X-Callback-Token": "bad" },
    }),
    ctx(id)
  );
  assert.equal(huge.status, 401);
  const malformed = await callbackRoute.POST(callbackRequest(id, "bad", "{nope"), ctx(id));
  assert.equal(malformed.status, 401);
});

test("callback: pending -> running -> completed with the result stored and polled", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const token = json.callback.token as string;
  const running = await callbackRoute.POST(
    callbackRequest(id, token, { status: "progress" }),
    ctx(id)
  );
  assert.equal(running.status, 200);
  assert.deepEqual(await running.json(), { ok: true, status: "running" });
  const done = await callbackRoute.POST(
    callbackRequest(id, token, { status: "completed", result: "OK\nall good" }),
    ctx(id)
  );
  assert.equal(done.status, 200);
  const { json: polled } = await poll(id);
  assert.equal(polled.job.status, "completed");
  assert.equal(polled.job.result, "OK\nall good");
});

test("callback: a failed report stores the error", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  await callbackRoute.POST(
    callbackRequest(id, json.callback.token, { status: "failed", error: "upstream said no" }),
    ctx(id)
  );
  const { json: polled } = await poll(id);
  assert.equal(polled.job.status, "failed");
  assert.equal(polled.job.error, "upstream said no");
});

test("callback: a late callback for a terminal job is 409 and leaves one names-only log line", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const token = json.callback.token as string;
  await callbackRoute.POST(
    callbackRequest(id, token, { status: "completed", result: "first" }),
    ctx(id)
  );

  const lines: string[] = [];
  const warnSpy = mock.method(logger, "warn", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  let late: Response;
  try {
    late = await callbackRoute.POST(
      callbackRequest(id, token, { status: "completed", result: "SECRET-BODY-TEXT" }),
      ctx(id)
    );
  } finally {
    warnSpy.mock.restore();
  }
  assert.equal(late.status, 409);
  assert.match((await late.json()).error.message, /job already in terminal state: completed/);
  assert.equal((await poll(id)).json.job.result, "first");
  const logged = lines.join("");
  assert.equal(lines.length, 1, "exactly one log line");
  assert.match(logged, new RegExp(`late callback rejected: job=${id} status=completed`));
  assert.equal(logged.includes(token), false);
  assert.equal(logged.includes("SECRET-BODY-TEXT"), false);
});

test("callback: strict validation rejects unknown fields, bad status and oversized fields (400)", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const token = json.callback.token as string;
  for (const body of [
    { status: "completed", extra: 1 },
    { status: "weird" },
    { result: "no status" },
    { status: "completed", result: "x".repeat(200_001) },
    { status: "failed", error: "x".repeat(2_001) },
    [1, 2, 3],
  ]) {
    const r = await callbackRoute.POST(callbackRequest(id, token, body), ctx(id));
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 50));
  }
  const malformed = await callbackRoute.POST(callbackRequest(id, token, "{nope"), ctx(id));
  assert.equal(malformed.status, 400);
  assert.equal((await poll(id)).json.job.status, "pending");
});

test("callback: the body cap is enforced on the declared and on the streamed size (413)", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const token = json.callback.token as string;
  const declared = await callbackRoute.POST(
    new Request(`${BASE}/api/async-callbacks/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Callback-Token": token,
        "content-length": String(300 * 1024),
      },
      body: JSON.stringify({ status: "completed" }),
    }),
    ctx(id)
  );
  assert.equal(declared.status, 413);
  const streamed = await callbackRoute.POST(
    callbackRequest(
      id,
      token,
      JSON.stringify({ status: "completed", result: "x".repeat(300 * 1024) })
    ),
    ctx(id)
  );
  assert.equal(streamed.status, 413);
});

test("callback: the per-job rate limit answers 429 with Retry-After after 30 calls a minute", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const token = json.callback.token as string;
  let last: Response | null = null;
  for (let i = 0; i < 31; i += 1) {
    last = await callbackRoute.POST(callbackRequest(id, token, { status: "running" }), ctx(id));
  }
  assert.equal(last?.status, 429);
  assert.ok(Number(last?.headers.get("retry-after")) >= 1);
});

test("callback: floods of wrong tokens are bounded globally (429 after 120 a minute)", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  let last: Response | null = null;
  for (let i = 0; i < 121; i += 1) {
    last = await callbackRoute.POST(
      callbackRequest(id, `wrong-${i}`, { status: "running" }),
      ctx(id)
    );
  }
  assert.equal(last?.status, 429);
});

test("callback: an expired job is refused with 409 and the late result is not stored", async () => {
  const { json } = await createJob({ ttlSeconds: 60 });
  const id = json.job.id as string;
  core
    .getDbInstance()
    .prepare("UPDATE async_jobs SET expires_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", id);
  const late = await callbackRoute.POST(
    callbackRequest(id, json.callback.token, { status: "completed", result: "late" }),
    ctx(id)
  );
  assert.equal(late.status, 409);
  assert.match((await late.json()).error.message, /terminal state: expired/);
  const { json: polled } = await poll(id);
  assert.equal(polled.job.status, "expired");
  assert.equal(polled.job.result, null);
});

test("errors never leak stack text", async () => {
  const { json } = await createJob();
  const id = json.job.id as string;
  const r = await callbackRoute.POST(callbackRequest(id, "bad", {}), ctx(id));
  const body = JSON.stringify(await r.json());
  assert.equal(body.includes("at /"), false);
  assert.equal(body.includes("node_modules"), false);
});

test("authz: the callback prefix is public, the creator routes are not", () => {
  assert.ok(publicRoutes.PUBLIC_API_ROUTE_PREFIXES.includes("/api/async-callbacks/"));
  assert.equal(publicRoutes.isPublicApiRoute("/api/async-callbacks/abc", "POST"), true);
  assert.equal(publicRoutes.isPublicApiRoute("/api/async-jobs", "POST"), false);
  assert.equal(publicRoutes.isPublicApiRoute("/api/async-jobs/abc", "GET"), false);
  assert.equal(publicRoutes.isPublicApiRoute("/api/async-callbacksx/abc", "POST"), false);
  assert.equal(classifyRoute("/api/async-jobs/abc", "GET").routeClass, "MANAGEMENT");
  assert.equal(classifyRoute("/api/async-callbacks/abc", "POST").routeClass, "PUBLIC");
  assert.ok(jobsDb.ASYNC_JOB_DEFAULT_TTL_SECONDS > 0);
});
