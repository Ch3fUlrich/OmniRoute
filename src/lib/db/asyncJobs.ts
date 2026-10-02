import { createHash, randomBytes, randomUUID } from "node:crypto";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
import { getDbInstance } from "./core";

/**
 * Generic store for work handed to an external system and answered later by a callback.
 * See migration 197_async_jobs.sql for the state machine.
 */

export type AsyncJobStatus = "pending" | "running" | "completed" | "failed" | "expired";

export interface AsyncJob {
  id: string;
  kind: string;
  status: AsyncJobStatus;
  metadata: Record<string, unknown> | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface AsyncJobRow {
  id: string;
  kind: string;
  status: AsyncJobStatus;
  token_hash: string;
  metadata: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** A job nobody answers inside this window becomes `expired` (2 h). */
export const ASYNC_JOB_DEFAULT_TTL_SECONDS = 2 * 60 * 60;
/** An identical idempotency key inside this window returns the existing job (15 min). */
const IDEMPOTENCY_WINDOW_SECONDS = 15 * 60;
/** Rows older than this are deleted when a new job is created (72 h). */
const RETENTION_SECONDS = 72 * 60 * 60;
const LIVE_STATUSES = ["pending", "running"] as const;
const EXPIRED_MESSAGE = "no callback before expiry";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function mapRow(row: AsyncJobRow): AsyncJob {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    metadata,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** Move every pending/running job past its expiry to `expired` (one atomic UPDATE). */
function expireStaleJobs(nowMs: number): void {
  const now = isoAt(nowMs);
  getDbInstance()
    .prepare(
      `UPDATE async_jobs
         SET status = 'expired', error = ?, updated_at = ?
       WHERE status IN ('pending', 'running') AND expires_at < ?`
    )
    .run(EXPIRED_MESSAGE, now, now);
}

function selectRow(id: string): AsyncJobRow | undefined {
  return getDbInstance().prepare("SELECT * FROM async_jobs WHERE id = ?").get(id) as
    AsyncJobRow | undefined;
}

export interface CreateAsyncJobInput {
  kind?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface CreateAsyncJobResult {
  job: AsyncJob;
  /** Plaintext callback token, present only for a newly created job. */
  callbackToken: string | null;
  reused: boolean;
}

/**
 * Create a job, or return the existing one for an identical idempotency key inside the
 * idempotency window. Only pending, running and completed jobs are reused: a failed or
 * expired job is never handed out again, so an explicit retry starts a new one.
 */
export function createAsyncJob(input: CreateAsyncJobInput = {}): CreateAsyncJobResult {
  const db = getDbInstance();
  const nowMs = input.nowMs ?? Date.now();
  const now = isoAt(nowMs);
  const ttl = input.ttlSeconds ?? ASYNC_JOB_DEFAULT_TTL_SECONDS;
  return db.transaction((): CreateAsyncJobResult => {
    db.prepare("DELETE FROM async_jobs WHERE created_at < ?").run(
      isoAt(nowMs - RETENTION_SECONDS * 1000)
    );
    expireStaleJobs(nowMs);

    if (input.idempotencyKey) {
      const existing = db
        .prepare(
          `SELECT * FROM async_jobs
           WHERE idempotency_key = ? AND created_at > ?
             AND status IN ('pending', 'running', 'completed')
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(input.idempotencyKey, isoAt(nowMs - IDEMPOTENCY_WINDOW_SECONDS * 1000)) as
        AsyncJobRow | undefined;
      if (existing) return { job: mapRow(existing), callbackToken: null, reused: true };
    }

    const id = randomUUID();
    const callbackToken = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO async_jobs
         (id, kind, status, token_hash, idempotency_key, metadata, created_at, updated_at, expires_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.kind ?? "webhook",
      hashToken(callbackToken),
      input.idempotencyKey ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
      isoAt(nowMs + ttl * 1000)
    );
    return { job: mapRow(selectRow(id) as AsyncJobRow), callbackToken, reused: false };
  })();
}

/** Read a job by id (after the expiry sweep, so a poll past the deadline already sees `expired`). */
export function getAsyncJob(id: string, nowMs: number = Date.now()): AsyncJob | null {
  expireStaleJobs(nowMs);
  const row = selectRow(id);
  return row ? mapRow(row) : null;
}

// A well-formed hash that no real token has, compared against when the job id is unknown so the
// answer takes the same path as a wrong token.
const NO_JOB_HASH = hashToken("no such job");

/** Constant-time check of a callback token; false for an unknown job or a wrong token alike. */
export function verifyAsyncJobCallbackToken(id: string, token: string): boolean {
  const row = selectRow(id);
  const matches = timingSafeCompare(hashToken(token), row?.token_hash ?? NO_JOB_HASH);
  return Boolean(row) && matches;
}

export interface AsyncJobCallbackUpdate {
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  nowMs?: number;
}

export type AsyncJobCallbackOutcome =
  | { ok: true; job: AsyncJob }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "terminal"; status: AsyncJobStatus };

/**
 * Apply a callback atomically. Only a pending or running job can move; a late callback for a
 * completed, failed or expired job is reported back as `terminal` (the route answers 409) and
 * changes nothing. A running update writes only the fields it carries, so a bare progress ping
 * never erases an earlier result.
 */
export function applyAsyncJobCallback(
  id: string,
  update: AsyncJobCallbackUpdate
): AsyncJobCallbackOutcome {
  const db = getDbInstance();
  const nowMs = update.nowMs ?? Date.now();
  return db.transaction((): AsyncJobCallbackOutcome => {
    expireStaleJobs(nowMs);
    const sets = ["status = ?", "updated_at = ?"];
    const values: Array<string> = [update.status, isoAt(nowMs)];
    if (update.result !== undefined) {
      sets.push("result = ?");
      values.push(update.result);
    }
    if (update.error !== undefined) {
      sets.push("error = ?");
      values.push(update.error);
    }
    const moved = db
      .prepare(
        `UPDATE async_jobs SET ${sets.join(", ")}
         WHERE id = ? AND status IN (${LIVE_STATUSES.map(() => "?").join(", ")})`
      )
      .run(...values, id, ...LIVE_STATUSES);
    const row = selectRow(id);
    if (!row) return { ok: false, reason: "not_found" };
    if (moved.changes === 0) return { ok: false, reason: "terminal", status: row.status };
    return { ok: true, job: mapRow(row) };
  })();
}
