/**
 * modelBenchmarks.ts — DB domain module for verified model benchmarks & throughput.
 *
 * Persists verified factual benchmark metrics (Artificial Analysis v4.3.2):
 * intelligence index, coding/agentic scores, SWE benchmarks, verified throughput (tok/s),
 * task cost (USD), price-cliff guardrails, and safe reasoning effort caps.
 *
 * @see Migration 213_model_benchmarks.sql
 */

import { getDbInstance, rowToCamel } from "./core";

// ──────────────── Types ────────────────

export interface ModelBenchmarkEntry {
  modelId: string;
  family: string;
  aaIntelligence: number;
  codingIndex?: number | null;
  agenticIndex?: number | null;
  terminalBench?: number | null;
  deepswe?: number | null;
  frontierCode?: number | null;
  scicode?: number | null;
  cyberbench?: number | null;
  verifiedTokPerS: number;
  directTokPerS?: number | null;
  altTokPerS?: number | null;
  ttftS?: number | null;
  costPerTaskUsd: number;
  cacheHitRate?: number | null;
  priceCliffTokens?: number | null;
  maxSafeEffort?: string | null;
  effortCaveat?: string | null;
  benchmarkSource: string;
  updatedAt?: string;
}

// ──────────────── Default Benchmarks (AA v4.3.2) ────────────────

export const DEFAULT_MODEL_BENCHMARKS: readonly ModelBenchmarkEntry[] = [
  {
    modelId: "claude-opus-5-5-high",
    family: "claude",
    aaIntelligence: 57.6,
    codingIndex: 84.2,
    agenticIndex: 81.5,
    terminalBench: 60.0,
    deepswe: 74.2,
    scicode: 45.0,
    verifiedTokPerS: 98,
    costPerTaskUsd: 1.82,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gemini-4-argon-high",
    family: "gemini",
    aaIntelligence: 53.0,
    codingIndex: 78.4,
    agenticIndex: 75.0,
    terminalBench: 57.0,
    deepswe: 77.9,
    scicode: 42.0,
    verifiedTokPerS: 115,
    costPerTaskUsd: 1.99,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gemini-4-argon-contributor",
    family: "gemini",
    aaIntelligence: 53.0,
    codingIndex: 78.4,
    agenticIndex: 75.0,
    terminalBench: 57.0,
    deepswe: 77.9,
    scicode: 42.0,
    verifiedTokPerS: 115,
    costPerTaskUsd: 0.5,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-astra-max",
    family: "gpt",
    aaIntelligence: 53.0,
    codingIndex: 62.0,
    agenticIndex: 76.5,
    terminalBench: 53.0,
    deepswe: 70.8,
    scicode: 41.5,
    verifiedTokPerS: 69,
    costPerTaskUsd: 3.26,
    maxSafeEffort: "max",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-sol-max",
    family: "gpt",
    aaIntelligence: 52.0,
    codingIndex: 60.0,
    agenticIndex: 74.5,
    terminalBench: 51.2,
    deepswe: 69.8,
    scicode: 40.0,
    verifiedTokPerS: 60,
    costPerTaskUsd: 0.72,
    maxSafeEffort: "max",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "claude-sonnet-5-5-xhigh",
    family: "claude",
    aaIntelligence: 51.9,
    codingIndex: 76.5,
    agenticIndex: 74.2,
    terminalBench: 70.6,
    deepswe: 69.5,
    frontierCode: 52.1,
    scicode: 39.5,
    verifiedTokPerS: 114,
    costPerTaskUsd: 1.12,
    maxSafeEffort: "xhigh",
    effortCaveat: "Never use max (193K token verbosity bloats 3P quota)",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-sol-xhigh",
    family: "gpt",
    aaIntelligence: 51.0,
    codingIndex: 75.2,
    agenticIndex: 73.0,
    terminalBench: 49.5,
    deepswe: 68.0,
    scicode: 38.5,
    verifiedTokPerS: 56,
    costPerTaskUsd: 0.39,
    maxSafeEffort: "xhigh",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-sol-high",
    family: "gpt",
    aaIntelligence: 50.0,
    codingIndex: 74.0,
    agenticIndex: 71.8,
    terminalBench: 48.0,
    deepswe: 66.5,
    scicode: 37.0,
    verifiedTokPerS: 51,
    costPerTaskUsd: 0.32,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-sol-medium",
    family: "gpt",
    aaIntelligence: 48.0,
    codingIndex: 71.5,
    agenticIndex: 69.0,
    terminalBench: 45.2,
    deepswe: 63.8,
    scicode: 35.0,
    verifiedTokPerS: 47,
    costPerTaskUsd: 0.21,
    maxSafeEffort: "medium",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "claude-sonnet-5-5-high",
    family: "claude",
    aaIntelligence: 46.8,
    codingIndex: 70.2,
    agenticIndex: 68.0,
    terminalBench: 44.0,
    deepswe: 62.5,
    scicode: 34.0,
    verifiedTokPerS: 100,
    costPerTaskUsd: 1.12,
    maxSafeEffort: "xhigh",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "mimo-v2.6-pro",
    family: "mimo",
    aaIntelligence: 46.0,
    codingIndex: 69.0,
    agenticIndex: 66.5,
    terminalBench: 42.8,
    deepswe: 61.0,
    scicode: 33.0,
    verifiedTokPerS: 51,
    directTokPerS: 29,
    costPerTaskUsd: 0.13,
    cacheHitRate: 0.924,
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "qwen3.8-max",
    family: "qwen",
    aaIntelligence: 45.4,
    codingIndex: 68.1,
    agenticIndex: 65.4,
    terminalBench: 42.0,
    deepswe: 60.1,
    scicode: 32.5,
    verifiedTokPerS: 85,
    costPerTaskUsd: 0.45,
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "deepseek-v4-flash-max",
    family: "deepseek",
    aaIntelligence: 45.0,
    codingIndex: 67.5,
    agenticIndex: 64.8,
    terminalBench: 41.5,
    deepswe: 59.5,
    scicode: 32.0,
    verifiedTokPerS: 231,
    altTokPerS: 380,
    costPerTaskUsd: 0.26,
    maxSafeEffort: "max",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "glm-5.2-max",
    family: "glm",
    aaIntelligence: 45.0,
    codingIndex: 71.5,
    agenticIndex: 50.9,
    terminalBench: 41.0,
    deepswe: 59.0,
    scicode: 52.0,
    verifiedTokPerS: 90,
    altTokPerS: 170,
    costPerTaskUsd: 0.18,
    maxSafeEffort: "max",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "muse-spark-1.3-contributor",
    family: "muse",
    aaIntelligence: 45.0,
    codingIndex: 75.8,
    agenticIndex: 55.5,
    terminalBench: 40.5,
    deepswe: 58.5,
    scicode: 31.5,
    verifiedTokPerS: 287,
    costPerTaskUsd: 1.37,
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "kimi-k3-max",
    family: "kimi",
    aaIntelligence: 44.0,
    codingIndex: 65.5,
    agenticIndex: 63.0,
    terminalBench: 39.8,
    deepswe: 57.2,
    scicode: 30.5,
    verifiedTokPerS: 43,
    costPerTaskUsd: 2.0,
    maxSafeEffort: "max",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "claude-haiku-4-5",
    family: "claude",
    aaIntelligence: 43.4,
    codingIndex: 64.2,
    agenticIndex: 61.5,
    terminalBench: 39.2,
    deepswe: 55.8,
    scicode: 29.8,
    verifiedTokPerS: 130,
    costPerTaskUsd: 0.21,
    priceCliffTokens: 100000,
    effortCaveat: "Price doubles above 100k context cliff",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-sol-low",
    family: "gpt",
    aaIntelligence: 42.0,
    codingIndex: 62.0,
    agenticIndex: 59.8,
    terminalBench: 37.0,
    deepswe: 53.5,
    scicode: 28.5,
    verifiedTokPerS: 46,
    costPerTaskUsd: 0.13,
    maxSafeEffort: "low",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gemini-3.8-flash-tiered-high",
    family: "gemini",
    aaIntelligence: 41.0,
    codingIndex: 61.0,
    agenticIndex: 58.5,
    terminalBench: 36.2,
    deepswe: 52.0,
    scicode: 27.5,
    verifiedTokPerS: 158,
    costPerTaskUsd: 1.24,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "claude-sonnet-5-5-medium",
    family: "claude",
    aaIntelligence: 40.8,
    codingIndex: 60.5,
    agenticIndex: 58.0,
    terminalBench: 35.8,
    deepswe: 51.5,
    scicode: 27.0,
    verifiedTokPerS: 105,
    costPerTaskUsd: 0.55,
    maxSafeEffort: "medium",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "qwen3.8-flash-next",
    family: "qwen",
    aaIntelligence: 40.0,
    codingIndex: 59.5,
    agenticIndex: 57.0,
    terminalBench: 35.0,
    deepswe: 50.2,
    scicode: 26.5,
    verifiedTokPerS: 300,
    costPerTaskUsd: 0.0,
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "gpt-6-luna-high",
    family: "gpt",
    aaIntelligence: 38.4,
    codingIndex: 57.0,
    agenticIndex: 54.5,
    terminalBench: 33.2,
    deepswe: 48.0,
    scicode: 25.0,
    verifiedTokPerS: 180,
    costPerTaskUsd: 0.07,
    maxSafeEffort: "high",
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
  {
    modelId: "mimo-v2.6-flash",
    family: "mimo",
    aaIntelligence: 37.9,
    codingIndex: 56.0,
    agenticIndex: 53.8,
    terminalBench: 32.5,
    deepswe: 47.0,
    scicode: 24.5,
    cyberbench: 75.4,
    verifiedTokPerS: 54,
    directTokPerS: 29,
    altTokPerS: 66.5,
    ttftS: 2.1,
    costPerTaskUsd: 0.04,
    cacheHitRate: 0.924,
    benchmarkSource: "AA-v4.3.2-2026-10",
  },
];

// ──────────────── Helpers ────────────────

function rowToEntry(row: Record<string, unknown>): ModelBenchmarkEntry {
  const camel = rowToCamel(row) ?? {};
  return {
    modelId: String(camel.modelId ?? ""),
    family: String(camel.family ?? ""),
    aaIntelligence: typeof camel.aaIntelligence === "number" ? camel.aaIntelligence : 0,
    codingIndex: typeof camel.codingIndex === "number" ? camel.codingIndex : null,
    agenticIndex: typeof camel.agenticIndex === "number" ? camel.agenticIndex : null,
    terminalBench: typeof camel.terminalBench === "number" ? camel.terminalBench : null,
    deepswe: typeof camel.deepswe === "number" ? camel.deepswe : null,
    frontierCode: typeof camel.frontierCode === "number" ? camel.frontierCode : null,
    scicode: typeof camel.scicode === "number" ? camel.scicode : null,
    cyberbench: typeof camel.cyberbench === "number" ? camel.cyberbench : null,
    verifiedTokPerS: typeof camel.verifiedTokPerS === "number" ? camel.verifiedTokPerS : 0,
    directTokPerS: typeof camel.directTokPerS === "number" ? camel.directTokPerS : null,
    altTokPerS: typeof camel.altTokPerS === "number" ? camel.altTokPerS : null,
    ttftS: typeof camel.ttftS === "number" ? camel.ttftS : null,
    costPerTaskUsd: typeof camel.costPerTaskUsd === "number" ? camel.costPerTaskUsd : 0,
    cacheHitRate: typeof camel.cacheHitRate === "number" ? camel.cacheHitRate : null,
    priceCliffTokens: typeof camel.priceCliffTokens === "number" ? camel.priceCliffTokens : null,
    maxSafeEffort: typeof camel.maxSafeEffort === "string" ? camel.maxSafeEffort : null,
    effortCaveat: typeof camel.effortCaveat === "string" ? camel.effortCaveat : null,
    benchmarkSource: String(camel.benchmarkSource ?? "AA-v4.3.2-2026-10"),
    updatedAt: typeof camel.updatedAt === "string" ? camel.updatedAt : undefined,
  };
}

// ──────────────── Table & Seeding ────────────────

export function ensureTableExists(db?: any): void {
  const targetDb = db || getDbInstance();
  targetDb.exec(`
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
  `);
}

export function seedDefaultModelBenchmarks(db?: any): number {
  const targetDb = db || getDbInstance();
  ensureTableExists(targetDb);
  const stmt = targetDb.prepare(`
    INSERT OR IGNORE INTO model_benchmarks (
      model_id, family, aa_intelligence, coding_index, agentic_index,
      terminal_bench, deepswe, frontier_code, scicode, cyberbench,
      verified_tok_per_s, direct_tok_per_s, alt_tok_per_s, ttft_s,
      cost_per_task_usd, cache_hit_rate, price_cliff_tokens,
      max_safe_effort, effort_caveat, benchmark_source
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  let inserted = 0;
  targetDb.transaction(() => {
    for (const b of DEFAULT_MODEL_BENCHMARKS) {
      const res = stmt.run(
        b.modelId,
        b.family,
        b.aaIntelligence,
        b.codingIndex ?? null,
        b.agenticIndex ?? null,
        b.terminalBench ?? null,
        b.deepswe ?? null,
        b.frontierCode ?? null,
        b.scicode ?? null,
        b.cyberbench ?? null,
        b.verifiedTokPerS,
        b.directTokPerS ?? null,
        b.altTokPerS ?? null,
        b.ttftS ?? null,
        b.costPerTaskUsd,
        b.cacheHitRate ?? null,
        b.priceCliffTokens ?? null,
        b.maxSafeEffort ?? null,
        b.effortCaveat ?? null,
        b.benchmarkSource || "AA-v4.3.2-2026-10"
      );
      if (res && res.changes && res.changes > 0) inserted++;
    }
  })();
  return inserted;
}

// ──────────────── Query & Lookup ────────────────

export function getAllModelBenchmarksMap(): Map<string, ModelBenchmarkEntry> {
  const db = getDbInstance();
  ensureTableExists(db);
  const countRow = db.prepare("SELECT COUNT(*) as count FROM model_benchmarks").get() as
    { count?: number } | undefined;
  if (!countRow || countRow.count === 0) {
    seedDefaultModelBenchmarks(db);
  }
  const rows = db.prepare("SELECT * FROM model_benchmarks").all() as Record<string, unknown>[];
  const map = new Map<string, ModelBenchmarkEntry>();
  for (const row of rows) {
    const entry = rowToEntry(row);
    map.set(entry.modelId, entry);
    map.set(entry.modelId.toLowerCase(), entry);
    const bare = entry.modelId.split("/").pop()!;
    map.set(bare, entry);
    map.set(bare.toLowerCase(), entry);
  }
  return map;
}

export function lookupModelBenchmarkFromMap(
  modelId: string,
  map?: Map<string, ModelBenchmarkEntry>
): ModelBenchmarkEntry | null {
  if (!modelId) return null;
  const lookupMap = map ?? getAllModelBenchmarksMap();
  const direct = lookupMap.get(modelId) ?? lookupMap.get(modelId.toLowerCase());
  if (direct) return direct;

  if (modelId.includes("/")) {
    const bare = modelId.split("/").pop()!;
    const bareMatch = lookupMap.get(bare) ?? lookupMap.get(bare.toLowerCase());
    if (bareMatch) return bareMatch;
  }
  return null;
}

export function getModelBenchmark(modelId: string): ModelBenchmarkEntry | null {
  const map = getAllModelBenchmarksMap();
  return lookupModelBenchmarkFromMap(modelId, map);
}

// ──────────────── Mutation & Import/Export ────────────────

export function upsertModelBenchmark(entry: ModelBenchmarkEntry): void {
  const db = getDbInstance();
  ensureTableExists(db);
  db.prepare(
    `
    INSERT OR REPLACE INTO model_benchmarks (
      model_id, family, aa_intelligence, coding_index, agentic_index,
      terminal_bench, deepswe, frontier_code, scicode, cyberbench,
      verified_tok_per_s, direct_tok_per_s, alt_tok_per_s, ttft_s,
      cost_per_task_usd, cache_hit_rate, price_cliff_tokens,
      max_safe_effort, effort_caveat, benchmark_source, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
  `
  ).run(
    entry.modelId,
    entry.family,
    entry.aaIntelligence,
    entry.codingIndex ?? null,
    entry.agenticIndex ?? null,
    entry.terminalBench ?? null,
    entry.deepswe ?? null,
    entry.frontierCode ?? null,
    entry.scicode ?? null,
    entry.cyberbench ?? null,
    entry.verifiedTokPerS,
    entry.directTokPerS ?? null,
    entry.altTokPerS ?? null,
    entry.ttftS ?? null,
    entry.costPerTaskUsd,
    entry.cacheHitRate ?? null,
    entry.priceCliffTokens ?? null,
    entry.maxSafeEffort ?? null,
    entry.effortCaveat ?? null,
    entry.benchmarkSource || "AA-v4.3.2-2026-10"
  );
}

export function bulkUpsertModelBenchmarks(entries: ModelBenchmarkEntry[]): number {
  if (entries.length === 0) return 0;
  const db = getDbInstance();
  ensureTableExists(db);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO model_benchmarks (
      model_id, family, aa_intelligence, coding_index, agentic_index,
      terminal_bench, deepswe, frontier_code, scicode, cyberbench,
      verified_tok_per_s, direct_tok_per_s, alt_tok_per_s, ttft_s,
      cost_per_task_usd, cache_hit_rate, price_cliff_tokens,
      max_safe_effort, effort_caveat, benchmark_source, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
  `);

  let count = 0;
  db.transaction(() => {
    for (const entry of entries) {
      stmt.run(
        entry.modelId,
        entry.family,
        entry.aaIntelligence,
        entry.codingIndex ?? null,
        entry.agenticIndex ?? null,
        entry.terminalBench ?? null,
        entry.deepswe ?? null,
        entry.frontierCode ?? null,
        entry.scicode ?? null,
        entry.cyberbench ?? null,
        entry.verifiedTokPerS,
        entry.directTokPerS ?? null,
        entry.altTokPerS ?? null,
        entry.ttftS ?? null,
        entry.costPerTaskUsd,
        entry.cacheHitRate ?? null,
        entry.priceCliffTokens ?? null,
        entry.maxSafeEffort ?? null,
        entry.effortCaveat ?? null,
        entry.benchmarkSource || "AA-v4.3.2-2026-10"
      );
      count++;
    }
  })();
  return count;
}

export function listModelBenchmarks(family?: string): ModelBenchmarkEntry[] {
  const db = getDbInstance();
  ensureTableExists(db);
  const countRow = db.prepare("SELECT COUNT(*) as count FROM model_benchmarks").get() as
    { count?: number } | undefined;
  if (!countRow || countRow.count === 0) {
    seedDefaultModelBenchmarks(db);
  }
  let sql = "SELECT * FROM model_benchmarks";
  const params: unknown[] = [];
  if (family) {
    sql += " WHERE family = ?";
    params.push(family);
  }
  sql += " ORDER BY aa_intelligence DESC, model_id ASC";
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function exportBenchmarksToJson(): string {
  const entries = listModelBenchmarks();
  return JSON.stringify(entries, null, 2);
}

export function importBenchmarksFromJson(jsonStr: string): number {
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) return 0;
  return bulkUpsertModelBenchmarks(parsed as ModelBenchmarkEntry[]);
}
