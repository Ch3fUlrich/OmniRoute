-- 213_model_benchmarks.sql
-- Verified model benchmark & throughput catalog (Artificial Analysis v4.3.2 metrics):
-- intelligence index, coding/agentic scores, SWE benchmarks, verified throughput (tok/s),
-- task cost (USD), price-cliff guardrails, and safe reasoning effort caps.

CREATE TABLE IF NOT EXISTS model_benchmarks (
  model_id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  aa_intelligence REAL NOT NULL,
  coding_index REAL,
  agentic_index REAL,
  terminal_bench REAL,
  deepswe REAL,
  frontier_code REAL,
  scicode REAL,
  cyberbench REAL,
  verified_tok_per_s REAL NOT NULL,
  direct_tok_per_s REAL,
  alt_tok_per_s REAL,
  ttft_s REAL,
  cost_per_task_usd REAL NOT NULL,
  cache_hit_rate REAL,
  price_cliff_tokens INTEGER,
  max_safe_effort TEXT,
  effort_caveat TEXT,
  benchmark_source TEXT NOT NULL DEFAULT 'AA-v4.3.2-2026-10',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_mb_family
  ON model_benchmarks (family);

CREATE INDEX IF NOT EXISTS idx_mb_intelligence
  ON model_benchmarks (aa_intelligence DESC);
