import test from "node:test";
import assert from "node:assert/strict";

import { resetDbInstance } from "../../../src/lib/db/core";
import {
  ensureTableExists,
  seedDefaultModelBenchmarks,
  getModelBenchmark,
  lookupModelBenchmarkFromMap,
  getAllModelBenchmarksMap,
  upsertModelBenchmark,
  bulkUpsertModelBenchmarks,
  listModelBenchmarks,
  exportBenchmarksToJson,
  importBenchmarksFromJson,
  DEFAULT_MODEL_BENCHMARKS,
  type ModelBenchmarkEntry,
} from "../../../src/lib/db/modelBenchmarks";
import {
  flattenCatalog,
  flattenCatalogModels,
  sortCatalogModels,
  type CatalogModelRow,
} from "../../../src/app/(dashboard)/dashboard/models/modelCatalogUtils";

test.beforeEach(() => {
  resetDbInstance();
});

test.after(() => {
  resetDbInstance();
});

test("model_benchmarks — seeds all 22 verified AA v4.3.2 benchmark rows", () => {
  const map = getAllModelBenchmarksMap();
  assert.ok(map.size > 0, "Benchmark map should not be empty");

  const benchmarks = listModelBenchmarks();
  assert.equal(benchmarks.length, 22, "Expected exactly 22 verified models");

  // Verify ranking: mimo-v2.6-pro (46.0) ranked above qwen3.8-max (45.4)
  const mimoPro = getModelBenchmark("mimo-v2.6-pro");
  assert.ok(mimoPro, "mimo-v2.6-pro should exist");
  assert.equal(mimoPro?.aaIntelligence, 46.0);
  assert.equal(mimoPro?.verifiedTokPerS, 51);
  assert.equal(mimoPro?.costPerTaskUsd, 0.13);

  const qwenMax = getModelBenchmark("qwen3.8-max");
  assert.ok(qwenMax, "qwen3.8-max should exist");
  assert.equal(qwenMax?.aaIntelligence, 45.4);
  assert.equal(qwenMax?.verifiedTokPerS, 85);
  assert.equal(qwenMax?.costPerTaskUsd, 0.45);
  assert.ok(
    mimoPro!.aaIntelligence > qwenMax!.aaIntelligence,
    "mimo-v2.6-pro should have higher AA intelligence than qwen3.8-max"
  );

  // Verify mimo-v2.6-flash (54 tok/s, 29 direct tok/s, $0.04)
  const mimoFlash = getModelBenchmark("mimo-v2.6-flash");
  assert.ok(mimoFlash, "mimo-v2.6-flash should exist");
  assert.equal(mimoFlash?.aaIntelligence, 37.9);
  assert.equal(mimoFlash?.verifiedTokPerS, 54);
  assert.equal(mimoFlash?.directTokPerS, 29);
  assert.equal(mimoFlash?.costPerTaskUsd, 0.04);

  // Verify gpt-6-luna-high (38.4, 180 tok/s, $0.07)
  const lunaHigh = getModelBenchmark("gpt-6-luna-high");
  assert.ok(lunaHigh, "gpt-6-luna-high should exist");
  assert.equal(lunaHigh?.aaIntelligence, 38.4);
  assert.equal(lunaHigh?.verifiedTokPerS, 180);
  assert.equal(lunaHigh?.costPerTaskUsd, 0.07);

  // Verify claude-opus-5-5-high top benchmark (57.6)
  const opusHigh = getModelBenchmark("claude-opus-5-5-high");
  assert.ok(opusHigh, "claude-opus-5-5-high should exist");
  assert.equal(opusHigh?.aaIntelligence, 57.6);

  // Verify claude-sonnet-5-5-xhigh safe reasoning effort cap
  const sonnetXhigh = getModelBenchmark("claude-sonnet-5-5-xhigh");
  assert.ok(sonnetXhigh, "claude-sonnet-5-5-xhigh should exist");
  assert.equal(sonnetXhigh?.aaIntelligence, 51.9);
  assert.equal(sonnetXhigh?.maxSafeEffort, "xhigh");

  // Verify claude-haiku-4-5 price cliff
  const haiku = getModelBenchmark("claude-haiku-4-5");
  assert.ok(haiku, "claude-haiku-4-5 should exist");
  assert.equal(haiku?.priceCliffTokens, 100000);
});

test("lookupModelBenchmarkFromMap — resolves both provider-prefixed and bare IDs", () => {
  const map = getAllModelBenchmarksMap();

  // Exact bare lookup
  const bare = lookupModelBenchmarkFromMap("claude-opus-5-5-high", map);
  assert.ok(bare, "Bare ID should resolve");
  assert.equal(bare?.modelId, "claude-opus-5-5-high");
  assert.equal(bare?.aaIntelligence, 57.6);

  // Provider-prefixed lookup (e.g. agy/...)
  const agyPrefixed = lookupModelBenchmarkFromMap("agy/claude-opus-5-5-high", map);
  assert.ok(agyPrefixed, "agy-prefixed ID should resolve to bare benchmark");
  assert.equal(agyPrefixed?.modelId, "claude-opus-5-5-high");

  // Other provider prefixes (anthropic/..., openrouter/...)
  const anthropicPrefixed = lookupModelBenchmarkFromMap("anthropic/claude-opus-5-5-high", map);
  assert.ok(anthropicPrefixed, "anthropic-prefixed ID should resolve");

  // Case-insensitive lookup
  const caseInsensitive = lookupModelBenchmarkFromMap("AGY/Claude-Opus-5-5-High", map);
  assert.ok(caseInsensitive, "Case insensitive lookup should resolve");

  // Unknown model returns null
  const unknown = lookupModelBenchmarkFromMap("unknown/non-existent-model", map);
  assert.equal(unknown, null);
});

test("model_benchmarks — JSON export & import round-trip", () => {
  const exportedJson = exportBenchmarksToJson();
  assert.ok(typeof exportedJson === "string", "Export should return JSON string");

  const parsed = JSON.parse(exportedJson);
  assert.ok(Array.isArray(parsed), "Parsed JSON should be an array");
  assert.equal(parsed.length, 22, "Exported array should have 22 entries");

  // Modify an entry and import
  const updatedList: ModelBenchmarkEntry[] = parsed.map((item: ModelBenchmarkEntry) => {
    if (item.modelId === "mimo-v2.6-pro") {
      return { ...item, verifiedTokPerS: 55, costPerTaskUsd: 0.12 };
    }
    return item;
  });

  const importedCount = importBenchmarksFromJson(JSON.stringify(updatedList));
  assert.equal(importedCount, 22, "Should import 22 entries");

  const reloaded = getModelBenchmark("mimo-v2.6-pro");
  assert.equal(reloaded?.verifiedTokPerS, 55);
  assert.equal(reloaded?.costPerTaskUsd, 0.12);
});

test("modelCatalogUtils — flattening extracts benchmark fields", () => {
  const rawCatalog = {
    anthropic: {
      provider: "Anthropic",
      models: [
        {
          id: "claude-opus-5-5-high",
          name: "Claude Opus 5.5 High",
          type: "chat",
          context_length: 200000,
          max_output_tokens: 8192,
          benchmarks: {
            aaIntelligence: 57.6,
            codingIndex: 84.2,
            agenticIndex: 81.5,
            terminalBench: 58.0,
            deepswe: 77.2,
            scicode: 45.0,
            verifiedTokPerS: 42,
            costPerTaskUsd: 1.45,
            priceCliffTokens: null,
            maxSafeEffort: "high",
            effortCaveat: null,
          },
        },
        {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          type: "chat",
          context_length: 200000,
          max_output_tokens: 8192,
          benchmarks: {
            aaIntelligence: 43.4,
            codingScore: 64.2,
            verifiedTokPerS: 145,
            costPerTaskUsd: 0.15,
            priceCliffTokens: 100000,
            effortCaveat: "Price doubles above 100k context cliff",
          },
        },
        {
          id: "custom-legacy-model",
          name: "Custom Legacy Model",
          type: "chat",
          benchmarks: null,
        },
      ],
    },
  };

  const rows = flattenCatalog(rawCatalog);
  assert.equal(rows.length, 3);

  // Also verify flattenCatalogModels alias
  const aliasRows = flattenCatalogModels(rawCatalog);
  assert.equal(aliasRows.length, 3);

  const opus = rows.find((r) => r.id === "claude-opus-5-5-high")!;
  assert.equal(opus.aaIntelligence, 57.6);
  assert.equal(opus.codingScore, 84.2);
  assert.equal(opus.verifiedTokPerS, 42);
  assert.equal(opus.costPerTaskUsd, 1.45);
  assert.equal(opus.effortCaveat, null);

  const haiku = rows.find((r) => r.id === "claude-haiku-4-5")!;
  assert.equal(haiku.aaIntelligence, 43.4);
  assert.equal(haiku.codingScore, 64.2);
  assert.equal(haiku.verifiedTokPerS, 145);
  assert.equal(haiku.costPerTaskUsd, 0.15);
  assert.equal(haiku.effortCaveat, "Price doubles above 100k context cliff");

  const legacy = rows.find((r) => r.id === "custom-legacy-model")!;
  assert.equal(legacy.aaIntelligence, null);
  assert.equal(legacy.codingScore, null);
  assert.equal(legacy.verifiedTokPerS, null);
  assert.equal(legacy.costPerTaskUsd, null);
  assert.equal(legacy.effortCaveat, null);
});

test("modelCatalogUtils — sorting by benchmark fields with null-last behavior", () => {
  const sampleRows: CatalogModelRow[] = [
    {
      providerId: "p1",
      provider: "P1",
      id: "model-c",
      name: "Model C",
      type: "chat",
      aaIntelligence: 40.0,
      codingScore: 50.0,
      verifiedTokPerS: 100,
      costPerTaskUsd: 0.2,
    },
    {
      providerId: "p1",
      provider: "P1",
      id: "model-null",
      name: "Model Null",
      type: "chat",
      aaIntelligence: null,
      codingScore: null,
      verifiedTokPerS: null,
      costPerTaskUsd: null,
    },
    {
      providerId: "p1",
      provider: "P1",
      id: "model-a",
      name: "Model A",
      type: "chat",
      aaIntelligence: 55.0,
      codingScore: 80.0,
      verifiedTokPerS: 300,
      costPerTaskUsd: 0.8,
    },
    {
      providerId: "p1",
      provider: "P1",
      id: "model-b",
      name: "Model B",
      type: "chat",
      aaIntelligence: 48.0,
      codingScore: 70.0,
      verifiedTokPerS: 200,
      costPerTaskUsd: 0.5,
    },
  ];

  // 1. aaIntelligence
  // Descending (highest first, null last)
  const intelDesc = sortCatalogModels(sampleRows, "aaIntelligence", "desc");
  assert.deepEqual(
    intelDesc.map((r) => r.id),
    ["model-a", "model-b", "model-c", "model-null"]
  );

  // Ascending (lowest first, null last)
  const intelAsc = sortCatalogModels(sampleRows, "aaIntelligence", "asc");
  assert.deepEqual(
    intelAsc.map((r) => r.id),
    ["model-c", "model-b", "model-a", "model-null"]
  );

  // 2. codingScore
  const codeDesc = sortCatalogModels(sampleRows, "codingScore", "desc");
  assert.deepEqual(
    codeDesc.map((r) => r.id),
    ["model-a", "model-b", "model-c", "model-null"]
  );

  const codeAsc = sortCatalogModels(sampleRows, "codingScore", "asc");
  assert.deepEqual(
    codeAsc.map((r) => r.id),
    ["model-c", "model-b", "model-a", "model-null"]
  );

  // 3. verifiedTokPerS
  const speedDesc = sortCatalogModels(sampleRows, "verifiedTokPerS", "desc");
  assert.deepEqual(
    speedDesc.map((r) => r.id),
    ["model-a", "model-b", "model-c", "model-null"]
  );

  const speedAsc = sortCatalogModels(sampleRows, "verifiedTokPerS", "asc");
  assert.deepEqual(
    speedAsc.map((r) => r.id),
    ["model-c", "model-b", "model-a", "model-null"]
  );

  // 4. costPerTaskUsd
  const costDesc = sortCatalogModels(sampleRows, "costPerTaskUsd", "desc");
  assert.deepEqual(
    costDesc.map((r) => r.id),
    ["model-a", "model-b", "model-c", "model-null"]
  );

  const costAsc = sortCatalogModels(sampleRows, "costPerTaskUsd", "asc");
  assert.deepEqual(
    costAsc.map((r) => r.id),
    ["model-c", "model-b", "model-a", "model-null"]
  );
});
