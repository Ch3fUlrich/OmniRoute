// tests/integration/smart-routing-production.test.ts
//
// Comprehensive end-to-end production-like integration test suite for OmniRoute
// Model Benchmarks Catalog and Dynamic Request Routing Envelope.
//
// Covers:
// 1. SQLite database initialization, seeding 22 AA v4.3.2 models, ranking mimo > qwen,
//    and JSON export/import round-trip.
// 2. End-to-end handleComboChat production simulation on a multi-family l2-worker combo:
//    - Implementation request with minIntelligence filter and ACP gating
//    - Cross-family review seat 1 (excluding implementer family claude)
//    - Cross-family review seat 2 (excluding both claude and mimo)
//    - Auto-combo 16-factor scoring session stickiness bypass (contextAffinity = 0)
//    - Fail-closed review guard (returns 400 on self-review exhaustion)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-smart-routing-prod-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const {
  ensureTableExists,
  seedDefaultModelBenchmarks,
  listModelBenchmarks,
  getModelBenchmark,
  exportBenchmarksToJson,
  importBenchmarksFromJson,
} = await import("../../src/lib/db/modelBenchmarks.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { detectModelFamily } = await import("../../open-sse/services/autoCombo/modelFamily.ts");
const { scoreAutoTargets } = await import("../../open-sse/services/combo/autoStrategy.ts");
const { DEFAULT_WEIGHTS } = await import("../../open-sse/services/autoCombo/scoring.ts");
const {
  shouldBypassSessionStickiness,
  extractRoutingEnvelope,
} = await import("../../open-sse/services/combo/requestEnvelopeFilter.ts");

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test.before(() => {
  resetDbInstance();
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  resetDbInstance();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

// ── 1. Database & Catalog Pipeline ───────────────────────────────────────────

test("Database & Catalog Pipeline: seeds, queries, rankings, and JSON round-trip", () => {
  ensureTableExists();
  seedDefaultModelBenchmarks();

  const benchmarks = listModelBenchmarks();
  assert.equal(benchmarks.length, 23, "All 23 verified AA v4.3.2 models seeded");

  // Verify gemini-4-argon-contributor exists and has 53.0 intelligence
  const argon = getModelBenchmark("gemini-4-argon-contributor");
  assert.ok(argon, "gemini-4-argon-contributor benchmark found");
  assert.equal(argon?.aaIntelligence, 53.0);
  assert.equal(argon?.verifiedTokPerS, 115);

  // Verify mimo-v2.6-pro ranks above qwen3.8-max in intelligence
  const mimo = getModelBenchmark("mimo-v2.6-pro");
  const qwen = getModelBenchmark("qwen3.8-max");
  assert.ok(mimo, "mimo-v2.6-pro benchmark found");
  assert.ok(qwen, "qwen3.8-max benchmark found");

  assert.equal(mimo.aaIntelligence, 46.0);
  assert.equal(mimo.verifiedTokPerS, 51.0);
  assert.equal(mimo.costPerTaskUsd, 0.13);

  assert.equal(qwen.aaIntelligence, 45.4);
  assert.equal(qwen.verifiedTokPerS, 85.0);
  assert.equal(qwen.costPerTaskUsd, 0.45);

  assert.ok(
    mimo.aaIntelligence > qwen.aaIntelligence,
    "mimo-v2.6-pro (46.0) ranks higher in intelligence than qwen3.8-max (45.4)"
  );

  // Test JSON export & import round-trip
  const exported = exportBenchmarksToJson();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.length, 23);

  const importedCount = importBenchmarksFromJson(exported);
  assert.equal(importedCount, 23, "Imported all 23 benchmarks");
});

// ── 2. End-to-End handleComboChat Production Simulation ───────────────────────

test("End-to-End handleComboChat: Implementation request with minIntelligence & ACP gating", async () => {
  const recordedDispatches: Array<{ modelStr: string; body: unknown }> = [];

  const handleSingleModelMock = async (body: any, modelStr: string) => {
    recordedDispatches.push({ modelStr, body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-impl",
        object: "chat.completion",
        created: Date.now(),
        model: modelStr,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Implementation by ${modelStr}` },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const l2WorkerCombo = {
    id: "combo-l2-worker",
    name: "l2-worker",
    strategy: "priority",
    models: [
      "agy/claude-sonnet-5-5-high",
      "mimo/mimo-v2.6-pro",
      "opencode-go/qwen3.8-max",
      "opencode-go/muse-spark-1.3-contributor",
      "cxa/gpt-6-astra-max",
      "cxa/gpt-6-luna-high",
      "claude/claude-haiku-4-5",
    ],
  };

  const response = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Implement the feature specification" }],
    },
    combo: l2WorkerCombo,
    handleSingleModel: handleSingleModelMock as any,
    isModelAvailable: async () => true,
    log: log as any,
    requestHeaders: {
      "x-omniroute-task-role": "implement",
      "x-omniroute-min-intelligence": "45.8",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(recordedDispatches.length, 1);
  // agy/claude-sonnet-5-5-high has AA Intelligence 46.8 >= 45.8 and is leg #1
  assert.equal(recordedDispatches[0].modelStr, "agy/claude-sonnet-5-5-high");
});

test("End-to-End handleComboChat: Cross-Family Review Seat 1 on same l2-worker combo", async () => {
  const recordedDispatches: Array<{ modelStr: string; body: unknown }> = [];

  const handleSingleModelMock = async (body: any, modelStr: string) => {
    recordedDispatches.push({ modelStr, body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-rev1",
        object: "chat.completion",
        created: Date.now(),
        model: modelStr,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Review 1 by ${modelStr}` },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const l2WorkerCombo = {
    id: "combo-l2-worker",
    name: "l2-worker",
    strategy: "priority",
    models: [
      "agy/claude-sonnet-5-5-high",
      "mimo/mimo-v2.6-pro",
      "opencode-go/qwen3.8-max",
      "opencode-go/muse-spark-1.3-contributor",
      "cxa/gpt-6-astra-max",
      "cxa/gpt-6-luna-high",
      "claude/claude-haiku-4-5",
    ],
  };

  const response = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Review code changes" }],
    },
    combo: l2WorkerCombo,
    handleSingleModel: handleSingleModelMock as any,
    isModelAvailable: async () => true,
    log: log as any,
    requestHeaders: {
      "x-omniroute-task-role": "review",
      "x-omniroute-author-model": "agy/claude-sonnet-5-5-high",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(recordedDispatches.length, 1);
  // All claude models are excluded. mimo/mimo-v2.6-pro is the next leg.
  assert.equal(recordedDispatches[0].modelStr, "mimo/mimo-v2.6-pro");
  assert.equal(detectModelFamily(recordedDispatches[0].modelStr), "mimo");
});

test("End-to-End handleComboChat: Cross-Family Review Seat 2 on same l2-worker combo (exclude claude & mimo)", async () => {
  const recordedDispatches: Array<{ modelStr: string; body: unknown }> = [];

  const handleSingleModelMock = async (body: any, modelStr: string) => {
    recordedDispatches.push({ modelStr, body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-rev2",
        object: "chat.completion",
        created: Date.now(),
        model: modelStr,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Review 2 by ${modelStr}` },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const l2WorkerCombo = {
    id: "combo-l2-worker",
    name: "l2-worker",
    strategy: "priority",
    models: [
      "agy/claude-sonnet-5-5-high",
      "mimo/mimo-v2.6-pro",
      "opencode-go/qwen3.8-max",
      "opencode-go/muse-spark-1.3-contributor",
      "cxa/gpt-6-astra-max",
      "cxa/gpt-6-luna-high",
      "claude/claude-haiku-4-5",
    ],
  };

  const response = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Second review seat" }],
    },
    combo: l2WorkerCombo,
    handleSingleModel: handleSingleModelMock as any,
    isModelAvailable: async () => true,
    log: log as any,
    requestHeaders: {
      "x-omniroute-task-role": "review",
      "x-omniroute-author-model": "agy/claude-sonnet-5-5-high",
      "x-omniroute-exclude-family": "claude,mimo",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(recordedDispatches.length, 1);
  // Both claude and mimo are excluded. Next leg is opencode-go/qwen3.8-max.
  assert.equal(recordedDispatches[0].modelStr, "opencode-go/qwen3.8-max");
  assert.equal(detectModelFamily(recordedDispatches[0].modelStr), "qwen");
});

test("Auto-Combo 16-Factor Strategy with Review Envelope: zeroes out contextAffinity & bypasses stickiness", async () => {
  const envelope = extractRoutingEnvelope({
    _omnirouteEnvelope: {
      taskRole: "review",
      authorModel: "agy/claude-sonnet-5-5-high",
    },
  });

  assert.ok(envelope);
  assert.equal(shouldBypassSessionStickiness(envelope), true);

  const mockTargets = [
    {
      stepId: "step-1",
      modelStr: "mimo/mimo-v2.6-pro",
      provider: "mimo",
      executionKey: "mimo:mimo-v2.6-pro",
      index: 0,
    },
    {
      stepId: "step-2",
      modelStr: "opencode-go/muse-spark-1.3-contributor",
      provider: "opencode-go",
      executionKey: "opencode-go:muse-spark-1.3-contributor",
      index: 1,
    },
  ];

  const mockCandidates = [
    {
      stepId: "step-1",
      executionKey: "mimo:mimo-v2.6-pro",
      modelStr: "mimo/mimo-v2.6-pro",
      provider: "mimo",
      model: "mimo-v2.6-pro",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 1,
      p95LatencyMs: 200,
      latencyStdDev: 20,
      errorRate: 0,
      contextAffinity: 0.95, // high stickiness from earlier session
    },
    {
      stepId: "step-2",
      executionKey: "opencode-go:muse-spark-1.3-contributor",
      modelStr: "opencode-go/muse-spark-1.3-contributor",
      provider: "opencode-go",
      model: "muse-spark-1.3-contributor",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 1,
      p95LatencyMs: 200,
      latencyStdDev: 20,
      errorRate: 0,
      contextAffinity: 0.0,
    },
  ];

  const scoredNormal = scoreAutoTargets(
    mockTargets as any,
    mockCandidates as any,
    "general",
    DEFAULT_WEIGHTS,
    null,
    null
  );
  assert.equal(scoredNormal[0].factors.contextAffinity, 0.95);

  const scoredReview = scoreAutoTargets(
    mockTargets as any,
    mockCandidates as any,
    "general",
    DEFAULT_WEIGHTS,
    null,
    envelope
  );
  assert.equal(scoredReview[0].factors.contextAffinity, 0);
  assert.ok(scoredReview[0].score > 0);
});

test("Fail-Closed Review Guard: refuses self-review when all combo targets belong to author family", async () => {
  const claudeOnlyCombo = {
    id: "combo-claude-only",
    name: "claude-only",
    strategy: "priority",
    models: ["agy/claude-sonnet-5-5-high", "claude/claude-haiku-4-5"],
  };

  const response = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "Review my code" }],
    },
    combo: claudeOnlyCombo,
    handleSingleModel: (async () => {
      assert.fail("Should never dispatch to a model when self-review is refused");
    }) as any,
    isModelAvailable: async () => true,
    log: log as any,
    requestHeaders: {
      "x-omniroute-task-role": "review",
      "x-omniroute-author-model": "agy/claude-sonnet-5-5-high",
    },
  });

  assert.equal(response.status, 400, "Refuses self-review with HTTP 400 Bad Request");
  const errorBody = await response.json();
  assert.equal(errorBody?.error?.code, "review_target_exhaustion");
  assert.match(errorBody?.error?.message, /excluded by cross-family review policy/i);
});
