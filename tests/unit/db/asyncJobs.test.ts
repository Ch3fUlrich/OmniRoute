/**
 * Tests for the generic async-job store (migration 197 + src/lib/db/asyncJobs.ts).
 *
 * Verifies:
 *  - create returns a pending job and a one-time plaintext token; only its hash is stored
 *  - the token check is right/wrong/unknown-job aware and never throws
 *  - idempotency: pending/running/completed jobs are reused inside the window, failed and expired
 *    jobs and keys outside the window are not
 *  - expiry: strictly after expires_at, applied on read, create and callback, never touches
 *    terminal rows
 *  - callbacks: pending/running only; late callbacks report the terminal state and change nothing;
 *    a bare running update never erases an earlier result
 *  - retention: old rows are removed when a job is created
 *  - the schema rejects an unknown status and the migration is idempotent
 *
 * Runs against an isolated temp DATA_DIR so the real database is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-async-jobs-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const jobs = await import("../../../src/lib/db/asyncJobs.ts");

const T0 = Date.parse("2026-10-02T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function rawRow(id: string) {
  return core.getDbInstance().prepare("SELECT * FROM async_jobs WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

test("create: a pending job, a 64-hex plaintext token once, only its SHA-256 stored", () => {
  const { job, callbackToken, reused } = jobs.createAsyncJob({ nowMs: T0 });
  assert.equal(reused, false);
  assert.equal(job.status, "pending");
  assert.equal(job.kind, "webhook");
  assert.equal(job.result, null);
  assert.equal(job.error, null);
  assert.equal(job.createdAt, "2026-10-02T10:00:00.000Z");
  assert.equal(job.expiresAt, "2026-10-02T12:00:00.000Z");
  assert.match(callbackToken ?? "", /^[0-9a-f]{64}$/);
  const row = rawRow(job.id);
  assert.notEqual(row.token_hash, callbackToken);
  assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(job).includes(String(callbackToken)), false);
  assert.equal(JSON.stringify(job).includes(String(row.token_hash)), false);
});

test("create: kind, metadata and ttl are honoured", () => {
  const { job } = jobs.createAsyncJob({
    kind: "queue-worker",
    metadata: { source: "unit", n: 3 },
    ttlSeconds: 600,
    nowMs: T0,
  });
  assert.equal(job.kind, "queue-worker");
  assert.deepEqual(job.metadata, { source: "unit", n: 3 });
  assert.equal(job.expiresAt, "2026-10-02T10:10:00.000Z");
});

test("token: right, wrong, empty and unknown-job tokens", () => {
  const { job, callbackToken } = jobs.createAsyncJob({ nowMs: T0 });
  assert.equal(jobs.verifyAsyncJobCallbackToken(job.id, callbackToken as string), true);
  assert.equal(jobs.verifyAsyncJobCallbackToken(job.id, "0".repeat(64)), false);
  assert.equal(jobs.verifyAsyncJobCallbackToken(job.id, ""), false);
  assert.equal(jobs.verifyAsyncJobCallbackToken("no-such-job", callbackToken as string), false);
  const other = jobs.createAsyncJob({ nowMs: T0 });
  assert.equal(jobs.verifyAsyncJobCallbackToken(job.id, other.callbackToken as string), false);
});

test("idempotency: a live job is reused inside the window, without a second token", () => {
  const first = jobs.createAsyncJob({ idempotencyKey: "k1", nowMs: T0 });
  const again = jobs.createAsyncJob({ idempotencyKey: "k1", nowMs: T0 + 5 * MIN });
  assert.equal(again.reused, true);
  assert.equal(again.job.id, first.job.id);
  assert.equal(again.callbackToken, null);
  const count = core.getDbInstance().prepare("SELECT COUNT(*) AS n FROM async_jobs").get() as {
    n: number;
  };
  assert.equal(count.n, 1);
});

test("idempotency: running and completed jobs are reused too", () => {
  const a = jobs.createAsyncJob({ idempotencyKey: "run", nowMs: T0 });
  jobs.applyAsyncJobCallback(a.job.id, { status: "running", nowMs: T0 + MIN });
  assert.equal(
    jobs.createAsyncJob({ idempotencyKey: "run", nowMs: T0 + 2 * MIN }).job.id,
    a.job.id
  );
  const b = jobs.createAsyncJob({ idempotencyKey: "done", nowMs: T0 });
  jobs.applyAsyncJobCallback(b.job.id, { status: "completed", result: "ok", nowMs: T0 + MIN });
  assert.equal(
    jobs.createAsyncJob({ idempotencyKey: "done", nowMs: T0 + 2 * MIN }).job.id,
    b.job.id
  );
});

test("idempotency: failed and expired jobs are never handed out again", () => {
  const failed = jobs.createAsyncJob({ idempotencyKey: "f", nowMs: T0 });
  jobs.applyAsyncJobCallback(failed.job.id, { status: "failed", error: "boom", nowMs: T0 + MIN });
  const retry = jobs.createAsyncJob({ idempotencyKey: "f", nowMs: T0 + 2 * MIN });
  assert.equal(retry.reused, false);
  assert.notEqual(retry.job.id, failed.job.id);

  const stale = jobs.createAsyncJob({ idempotencyKey: "e", ttlSeconds: 60, nowMs: T0 });
  const after = jobs.createAsyncJob({ idempotencyKey: "e", nowMs: T0 + 5 * MIN });
  assert.equal(after.reused, false);
  assert.notEqual(after.job.id, stale.job.id);
  assert.equal(jobs.getAsyncJob(stale.job.id, T0 + 5 * MIN)?.status, "expired");
});

test("idempotency: a key outside the 15 minute window starts a new job", () => {
  const first = jobs.createAsyncJob({ idempotencyKey: "w", nowMs: T0 });
  const late = jobs.createAsyncJob({ idempotencyKey: "w", nowMs: T0 + 16 * MIN });
  assert.equal(late.reused, false);
  assert.notEqual(late.job.id, first.job.id);
});

test("expiry: strictly after expires_at, applied on read, only to pending/running", () => {
  const { job } = jobs.createAsyncJob({ ttlSeconds: 3600, nowMs: T0 });
  assert.equal(jobs.getAsyncJob(job.id, T0 + HOUR)?.status, "pending"); // exactly at the deadline
  const expired = jobs.getAsyncJob(job.id, T0 + HOUR + 1);
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.error, "no callback before expiry");

  const done = jobs.createAsyncJob({ ttlSeconds: 60, nowMs: T0 });
  jobs.applyAsyncJobCallback(done.job.id, { status: "completed", result: "r", nowMs: T0 + 10_000 });
  assert.equal(jobs.getAsyncJob(done.job.id, T0 + 5 * HOUR)?.status, "completed");
});

test("expiry: a running job past its deadline expires although it kept reporting progress", () => {
  const { job } = jobs.createAsyncJob({ ttlSeconds: 600, nowMs: T0 });
  jobs.applyAsyncJobCallback(job.id, { status: "running", nowMs: T0 + 9 * MIN });
  assert.equal(jobs.getAsyncJob(job.id, T0 + 11 * MIN)?.status, "expired");
});

test("callback: pending -> running -> completed, fields carried only when present", () => {
  const { job } = jobs.createAsyncJob({ nowMs: T0 });
  const r1 = jobs.applyAsyncJobCallback(job.id, { status: "running", nowMs: T0 + MIN });
  assert.equal(r1.ok && r1.job.status, "running");
  const r2 = jobs.applyAsyncJobCallback(job.id, {
    status: "completed",
    result: "answer",
    nowMs: T0 + 2 * MIN,
  });
  assert.equal(r2.ok && r2.job.status, "completed");
  assert.equal(r2.ok && r2.job.result, "answer");
  assert.equal(r2.ok && r2.job.updatedAt, "2026-10-02T10:02:00.000Z");
});

test("callback: a bare running update never erases an earlier result or error", () => {
  const { job } = jobs.createAsyncJob({ nowMs: T0 });
  jobs.applyAsyncJobCallback(job.id, { status: "running", result: "partial", nowMs: T0 + MIN });
  const bare = jobs.applyAsyncJobCallback(job.id, { status: "running", nowMs: T0 + 2 * MIN });
  assert.equal(bare.ok && bare.job.result, "partial");
});

test("callback: a late callback for a terminal job reports the state and changes nothing", () => {
  const { job } = jobs.createAsyncJob({ nowMs: T0 });
  jobs.applyAsyncJobCallback(job.id, { status: "completed", result: "first", nowMs: T0 + MIN });
  const late = jobs.applyAsyncJobCallback(job.id, {
    status: "completed",
    result: "second",
    nowMs: T0 + 2 * MIN,
  });
  assert.deepEqual(late, { ok: false, reason: "terminal", status: "completed" });
  assert.equal(jobs.getAsyncJob(job.id, T0 + 3 * MIN)?.result, "first");

  const failed = jobs.createAsyncJob({ nowMs: T0 });
  jobs.applyAsyncJobCallback(failed.job.id, { status: "failed", error: "x", nowMs: T0 + MIN });
  const lateFail = jobs.applyAsyncJobCallback(failed.job.id, {
    status: "running",
    nowMs: T0 + 2 * MIN,
  });
  assert.deepEqual(lateFail, { ok: false, reason: "terminal", status: "failed" });
});

test("callback: after the deadline the job is expired, the callback is refused and nothing is stored", () => {
  const { job } = jobs.createAsyncJob({ ttlSeconds: 60, nowMs: T0 });
  const late = jobs.applyAsyncJobCallback(job.id, {
    status: "completed",
    result: "too late",
    nowMs: T0 + 2 * MIN,
  });
  assert.deepEqual(late, { ok: false, reason: "terminal", status: "expired" });
  assert.equal(jobs.getAsyncJob(job.id, T0 + 3 * MIN)?.result, null);
});

test("callback: an unknown job id is not_found", () => {
  assert.deepEqual(jobs.applyAsyncJobCallback("missing", { status: "completed", nowMs: T0 }), {
    ok: false,
    reason: "not_found",
  });
});

test("retention: rows older than 72 hours are deleted when a job is created", () => {
  const old = jobs.createAsyncJob({ nowMs: T0 });
  jobs.createAsyncJob({ nowMs: T0 + 71 * HOUR });
  assert.ok(jobs.getAsyncJob(old.job.id, T0 + 71 * HOUR));
  jobs.createAsyncJob({ nowMs: T0 + 73 * HOUR });
  assert.equal(rawRow(old.job.id), undefined);
});

test("schema: an unknown status is rejected and the migration is idempotent", () => {
  const db = core.getDbInstance();
  const { job } = jobs.createAsyncJob({ nowMs: T0 });
  assert.throws(() =>
    db.prepare("UPDATE async_jobs SET status = 'bogus' WHERE id = ?").run(job.id)
  );
  const sql = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "db", "migrations", "197_async_jobs.sql"),
    "utf8"
  );
  assert.doesNotThrow(() => db.exec(sql));
  assert.equal(jobs.getAsyncJob(job.id, T0)?.status, "pending");
});
