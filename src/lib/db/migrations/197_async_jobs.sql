-- Migration 197: async_jobs
--
-- Generic store for work that is handed to an EXTERNAL system and answered later by a
-- callback (a webhook-triggered bot, a queue worker, a long-running agent run). The row
-- is the state machine; nothing here is specific to one provider.
--
--   status           pending   created, waiting for the external system
--                    running   the external system reported progress
--                    completed terminal: the external system delivered a result
--                    failed    terminal: the external system (or the caller) reported failure
--                    expired   terminal: nothing arrived before expires_at (NOT "failed":
--                              nobody reported a failure)
--   token_hash       SHA-256 of the per-job callback token. The plaintext token is shown to
--                    the creator once; a leaked database cannot be used to post results.
--   idempotency_key  optional caller-chosen key; an identical key inside the idempotency
--                    window returns the existing live or completed job (failed and expired
--                    jobs are never handed out again).
--   expires_at       ISO-8601 UTC; pending/running rows past it become 'expired' on the next
--                    read or callback (no background timer).
--
-- Timestamps are ISO-8601 UTC strings produced in code, so lexicographic order is time order.

CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'webhook',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
  token_hash TEXT NOT NULL,
  idempotency_key TEXT,
  metadata TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_async_jobs_status_expires ON async_jobs(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_async_jobs_idempotency ON async_jobs(idempotency_key, created_at);
