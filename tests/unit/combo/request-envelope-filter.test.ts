import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectModelFamily,
  MODEL_FAMILIES,
  MODEL_FAMILY_METADATA,
} from "../../../open-sse/services/autoCombo/modelFamily.ts";
import {
  extractRequestOverrides,
  type RequestOverrides,
} from "../../../open-sse/services/autoCombo/requestControls.ts";
import {
  BUILT_IN_INTELLIGENCE_INDEX,
  PRICE_CLIFF_TOKENS,
  getModelIntelligenceScore,
  extractRoutingEnvelope,
  shouldBypassSessionStickiness,
  filterTargetsByRequestEnvelope,
  type RequestRoutingEnvelope,
} from "../../../open-sse/services/combo/requestEnvelopeFilter.ts";
import { filterTargetsByRequestCompatibility } from "../../../open-sse/services/combo/comboStructure.ts";
import { scoreAutoTargets } from "../../../open-sse/services/combo/autoStrategy.ts";
import type {
  ResolvedComboTarget,
  AutoProviderCandidate,
} from "../../../open-sse/services/combo/types.ts";
import { DEFAULT_WEIGHTS } from "../../../open-sse/services/autoCombo/scoring.ts";

describe("detectModelFamily", () => {
  it("recognizes all frontier coding model families with provider prefixes", () => {
    assert.equal(detectModelFamily("agy/claude-sonnet-5-5-high"), "claude-sonnet");
    assert.equal(detectModelFamily("opencode-go/muse-spark-1.3-contributor"), "muse");
    assert.equal(detectModelFamily("mimo/mimo-v2.6-pro"), "mimo");
    assert.equal(detectModelFamily("cxa/gpt-6-luna-high"), "gpt");
    assert.equal(detectModelFamily("opencode-go/qwen3.8-max"), "qwen");
    assert.equal(detectModelFamily("agy/gemini-3.8-flash-tiered-high"), "gemini");
    assert.equal(detectModelFamily("opencode-go/deepseek-v4-flash-max"), "deepseek");
  });

  it("recognizes bare model strings and opus/sonnet/haiku patterns", () => {
    assert.equal(detectModelFamily("claude-opus-5-5-high"), "claude-opus");
    assert.equal(detectModelFamily("claude-haiku-4-5"), "claude-haiku");
    assert.equal(detectModelFamily("haiku-4-5"), "claude-haiku");
    assert.equal(detectModelFamily("sonnet-5-5"), "claude-sonnet");
    assert.equal(detectModelFamily("opus-4-1"), "claude-opus");
    assert.equal(detectModelFamily("muse-spark"), "muse");
    assert.equal(detectModelFamily("glm-5.2-max"), "glm");
    assert.equal(detectModelFamily("kimi-k3-max"), "kimi");
  });

  it("returns null for unknown, empty, or invalid inputs", () => {
    assert.equal(detectModelFamily("unknown-model-xyz"), null);
    assert.equal(detectModelFamily(""), null);
    assert.equal(detectModelFamily("   "), null);
    assert.equal(detectModelFamily(null), null);
    assert.equal(detectModelFamily(undefined), null);
  });

  it("includes claude tiers in MODEL_FAMILIES and exposes metadata", () => {
    assert.ok(MODEL_FAMILIES.includes("claude-sonnet"));
    assert.ok(MODEL_FAMILIES.includes("claude-opus"));
    assert.ok(MODEL_FAMILIES.includes("claude-haiku"));
    assert.equal(MODEL_FAMILY_METADATA["claude-sonnet"]?.providerOrigin, "anthropic");
    assert.equal(MODEL_FAMILY_METADATA["claude-sonnet"]?.capabilityTier, "flagship");
    assert.ok(MODEL_FAMILY_METADATA["claude-sonnet"]?.strengths.includes("review"));
    assert.equal(MODEL_FAMILY_METADATA.muse?.providerOrigin, "opencode");
    assert.equal(MODEL_FAMILY_METADATA.muse?.capabilityTier, "pro");
  });
});

describe("extractRequestOverrides", () => {
  it("parses required context from object maps and Headers", () => {
    const absent: RequestOverrides = extractRequestOverrides({});
    assert.equal(absent.requiredContextTokens, undefined);
    const cases = [
      ["131072", 131072],
      [" 128k ", 128000],
      ["1M", 1000000],
      ["1.5m", 1500000],
      ["1.2345k", 1235],
    ] as const;
    for (const [value, expected] of cases) {
      const headers = { "X-OmniRoute-Required-Context": value };
      for (const input of [headers, new Headers(headers)]) {
        assert.equal(extractRequestOverrides(input).requiredContextTokens, expected);
      }
    }
  });

  it("ignores invalid required context values", () => {
    for (const value of ["0", "-5", "abc", "", "NaN", "1.5", "1e5", "0k", "1kb", "Infinity"]) {
      const headers = { "x-omniroute-required-context": value };
      for (const input of [headers, new Headers(headers)]) {
        assert.equal(extractRequestOverrides(input).requiredContextTokens, undefined);
      }
    }
  });

  it("parses valid header controls and normalizes them", () => {
    const headers = {
      "X-OmniRoute-Task-Role": "review",
      "X-OmniRoute-Exclude-Family": "mimo, qwen",
      "X-OmniRoute-Min-Intelligence": "45.5",
      "X-OmniRoute-Risk": "critical",
      "X-OmniRoute-Effort": "max",
    };
    const overrides = extractRequestOverrides(headers);
    assert.equal(overrides.taskRole, "review");
    assert.deepEqual(overrides.excludeFamilies, ["mimo", "qwen"]);
    assert.equal(overrides.minIntelligence, 45.5);
    assert.equal(overrides.risk, "critical");
    assert.equal(overrides.effort, "max");
  });

  it("automatically appends authorModel family to excludeFamilies (deduplicated)", () => {
    const headers = {
      "X-OmniRoute-Author-Model": "agy/claude-sonnet-5-5-high",
      "X-OmniRoute-Exclude-Family": "mimo, claude-sonnet",
    };
    const overrides = extractRequestOverrides(headers);
    assert.equal(overrides.authorModel, "agy/claude-sonnet-5-5-high");
    assert.deepEqual(overrides.excludeFamilies, ["mimo", "claude-sonnet"]);
  });

  it("appends authorModel family when excludeFamilies is otherwise unset", () => {
    const headers = {
      "X-OmniRoute-Author-Model": "opencode-go/muse-spark-1.3-contributor",
    };
    const overrides = extractRequestOverrides(headers);
    assert.equal(overrides.authorModel, "opencode-go/muse-spark-1.3-contributor");
    assert.deepEqual(overrides.excludeFamilies, ["muse"]);
  });

  it("ignores invalid role, negative intelligence, or empty values", () => {
    const headers = {
      "X-OmniRoute-Task-Role": "invalid_role",
      "X-OmniRoute-Min-Intelligence": "-5.0",
      "X-OmniRoute-Risk": "ultra_extreme",
      "X-OmniRoute-Effort": "supersonic",
    };
    const overrides = extractRequestOverrides(headers);
    assert.equal(overrides.taskRole, undefined);
    assert.equal(overrides.minIntelligence, undefined);
    assert.equal(overrides.risk, undefined);
    assert.equal(overrides.effort, undefined);
  });

  it("handles null, undefined, or empty headers object", () => {
    assert.deepEqual(extractRequestOverrides(null), {});
    assert.deepEqual(extractRequestOverrides(undefined), {});
    assert.deepEqual(extractRequestOverrides({}), {});
  });
});

describe("Cross-family review enforcement with l2-worker combo", () => {
  it("fails closed for review with an unknown author and no exclusions", () => {
    const targets = [{ modelStr: "glm-5.2-max" }];
    assert.deepEqual(
      filterTargetsByRequestEnvelope(targets, {
        taskRole: "review",
        authorModel: "totally-unknown-model-xyz",
      }),
      []
    );
  });

  it("fails closed for review with no author and no exclusions", () => {
    assert.deepEqual(
      filterTargetsByRequestEnvelope([{ modelStr: "glm-5.2-max" }], { taskRole: "review" }),
      []
    );
  });

  it("filters review normally with an unknown author and explicit exclusions", () => {
    const targets = [{ modelStr: "glm-5.2-max" }, { modelStr: "kimi-k3-max" }];
    assert.deepEqual(
      filterTargetsByRequestEnvelope(targets, {
        taskRole: "review",
        authorModel: "totally-unknown-model-xyz",
        excludeFamilies: ["glm"],
      }),
      [targets[1]]
    );
  });

  it("keeps non-review roles fail-open without a recognized author", () => {
    const targets = [{ modelStr: "glm-5.2-max" }];
    for (const taskRole of ["implement", "orchestrate", "drive"] as const) {
      for (const authorModel of [undefined, "totally-unknown-model-xyz"]) {
        assert.deepEqual(filterTargetsByRequestEnvelope(targets, { taskRole, authorModel }), targets);
      }
    }
  });

  const l2WorkerTargets = [
    { modelStr: "opencode-go/muse-spark-1.3-contributor", provider: "opencode-go" },
    { modelStr: "mimo/mimo-v2.6-pro", provider: "mimo" },
    { modelStr: "agy/claude-sonnet-5-5-high", provider: "agy" },
    { modelStr: "opencode-go/qwen3.8-max", provider: "opencode-go" },
    { modelStr: "opencode-go/deepseek-v4-flash-max", provider: "opencode-go" },
    { modelStr: "agy/gemini-3.8-flash-tiered-high", provider: "agy" },
    { modelStr: "cxa/gpt-6-luna-high", provider: "cxa" },
  ];

  it("excludes author model family on review task (implementer: claude)", () => {
    const envelope: RequestRoutingEnvelope = {
      taskRole: "review",
      authorModel: "agy/claude-sonnet-5-5-high",
    };
    const survivors = filterTargetsByRequestEnvelope(l2WorkerTargets, envelope);
    const survivorFamilies = survivors.map((t) => detectModelFamily(t.modelStr));
    assert.ok(!survivorFamilies.includes("claude"));
    assert.equal(survivors.length, 6);
  });

  it("excludes both implementer and Reviewer 1 families for Reviewer 2", () => {
    const envelope: RequestRoutingEnvelope = {
      taskRole: "review",
      excludeFamilies: ["claude", "mimo"],
    };
    const survivors = filterTargetsByRequestEnvelope(l2WorkerTargets, envelope);
    const survivorFamilies = survivors.map((t) => detectModelFamily(t.modelStr));
    assert.ok(!survivorFamilies.includes("claude"));
    assert.ok(!survivorFamilies.includes("mimo"));
    assert.equal(survivors.length, 5);
    assert.ok(survivorFamilies.includes("muse"));
    assert.ok(survivorFamilies.includes("qwen"));
  });

  it("never resurrects same-family targets on review task when all targets are excluded", () => {
    const onlyClaudeTargets = [
      { modelStr: "agy/claude-sonnet-5-5-high", provider: "agy" },
      { modelStr: "anthropic/claude-haiku-4-5", provider: "anthropic" },
    ];
    const envelope: RequestRoutingEnvelope = {
      taskRole: "review",
      excludeFamilies: ["claude"],
    };
    const survivors = filterTargetsByRequestEnvelope(onlyClaudeTargets, envelope);
    assert.deepEqual(survivors, []);
  });

  it("falls back to full pool on non-review task if all targets were excluded", () => {
    const onlyClaudeTargets = [
      { modelStr: "agy/claude-sonnet-5-5-high", provider: "agy" },
      { modelStr: "anthropic/claude-haiku-4-5", provider: "anthropic" },
    ];
    const envelope: RequestRoutingEnvelope = {
      taskRole: "implement",
      excludeFamilies: ["claude"],
    };
    const survivors = filterTargetsByRequestEnvelope(onlyClaudeTargets, envelope);
    assert.equal(survivors.length, 2);
  });
});

describe("shouldBypassSessionStickiness", () => {
  it("returns true for review taskRole or non-empty excludeFamilies", () => {
    assert.equal(shouldBypassSessionStickiness({ taskRole: "review" }), true);
    assert.equal(shouldBypassSessionStickiness({ excludeFamilies: ["claude"] }), true);
    assert.equal(shouldBypassSessionStickiness({ taskRole: "review", excludeFamilies: ["gpt"] }), true);
  });

  it("returns false for implement role with no excluded families, or empty envelope", () => {
    assert.equal(shouldBypassSessionStickiness({ taskRole: "implement" }), false);
    assert.equal(shouldBypassSessionStickiness({ taskRole: "orchestrate", excludeFamilies: [] }), false);
    assert.equal(shouldBypassSessionStickiness(null), false);
    assert.equal(shouldBypassSessionStickiness(undefined), false);
  });

  it("zeros out contextAffinity in scoreAutoTargets when stickiness is bypassed", () => {
    const mockTargets: ResolvedComboTarget[] = [
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

    const mockCandidates: AutoProviderCandidate[] = [
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
      mockTargets,
      mockCandidates,
      "general",
      DEFAULT_WEIGHTS,
      null,
      null
    );
    // Under normal conditions, mimo has high contextAffinity
    assert.equal(scoredNormal[0].factors.contextAffinity, 0.95);

    const scoredReview = scoreAutoTargets(
      mockTargets,
      mockCandidates,
      "general",
      DEFAULT_WEIGHTS,
      null,
      { taskRole: "review", excludeFamilies: ["glm"] }
    );
    // Under review envelope, stickiness is bypassed: contextAffinity is 0
    assert.equal(scoredReview[0].factors.contextAffinity, 0);
  });
});

describe("Min-Intelligence filtering and intelligence index", () => {
  const candidatePool = [
    { modelStr: "mimo/mimo-v2.6-pro", provider: "mimo" }, // score: 46.0
    { modelStr: "opencode-go/qwen3.8-max", provider: "opencode-go" }, // score: 45.4
    { modelStr: "cxa/gpt-6-luna-high", provider: "cxa" }, // score: 38.4
  ];

  it("filters out models with score < minIntelligence (45.5 drops qwen 45.4, keeps mimo 46.0)", () => {
    const envelope: RequestRoutingEnvelope = {
      minIntelligence: 45.5,
    };
    const survivors = filterTargetsByRequestEnvelope(candidatePool, envelope);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].modelStr, "mimo/mimo-v2.6-pro");
  });

  it("falls back to sorting survivors by intelligence descending when none qualify", () => {
    const envelope: RequestRoutingEnvelope = {
      minIntelligence: 55.0, // higher than all models in candidatePool
    };
    const survivors = filterTargetsByRequestEnvelope(candidatePool, envelope);
    assert.equal(survivors.length, 3);
    assert.equal(survivors[0].modelStr, "mimo/mimo-v2.6-pro"); // 46.0
    assert.equal(survivors[1].modelStr, "opencode-go/qwen3.8-max"); // 45.4
    assert.equal(survivors[2].modelStr, "cxa/gpt-6-luna-high"); // 38.4
  });

  it("prefers table scores over built-in scores when applying the threshold", () => {
    const pool = [
      { modelStr: "mimo/mimo-v2.6-pro" },
      { modelStr: "anthropic/claude-opus-5-5-high" },
    ];
    const scores = new Map([
      [pool[0].modelStr, 80],
      [pool[1].modelStr, 30],
    ]);
    assert.deepEqual(filterTargetsByRequestEnvelope(pool, { minIntelligence: 50 }, scores), [
      pool[0],
    ]);
    assert.deepEqual(filterTargetsByRequestEnvelope(pool, { minIntelligence: 50 }), [pool[1]]);
  });

  it("uses built-in scores for models absent from the table map", () => {
    const scores = new Map([[candidatePool[0].modelStr, 30]]);
    assert.deepEqual(
      filterTargetsByRequestEnvelope(candidatePool, { minIntelligence: 45 }, scores),
      [candidatePool[1]]
    );
    assert.deepEqual(
      filterTargetsByRequestEnvelope(candidatePool, { minIntelligence: 45 }, new Map()),
      candidatePool.slice(0, 2)
    );
  });

  it("uses table scores for fallback ordering when no model qualifies", () => {
    const scores = new Map([
      [candidatePool[0].modelStr, 10],
      [candidatePool[1].modelStr, 30],
      [candidatePool[2].modelStr, 20],
    ]);
    assert.deepEqual(
      filterTargetsByRequestEnvelope(candidatePool, { minIntelligence: 50 }, scores),
      [candidatePool[1], candidatePool[2], candidatePool[0]]
    );
  });

  it("resolves scores for the 22 built-in AA v4.3.2 models", () => {
    assert.equal(BUILT_IN_INTELLIGENCE_INDEX["claude-haiku-4-5"], 43.4);
    assert.equal(getModelIntelligenceScore("claude-opus-5-5-high"), 57.6);
    assert.equal(getModelIntelligenceScore("gemini-4-argon-high"), 53.0);
    assert.equal(getModelIntelligenceScore("gpt-6-astra-max"), 53.0);
    assert.equal(getModelIntelligenceScore("gpt-6-sol-max"), 52.0);
    assert.equal(getModelIntelligenceScore("claude-sonnet-5-5-xhigh"), 51.9);
    assert.equal(getModelIntelligenceScore("gpt-6-sol-xhigh"), 51.0);
    assert.equal(getModelIntelligenceScore("gpt-6-sol-high"), 50.0);
    assert.equal(getModelIntelligenceScore("gpt-6-sol-medium"), 48.0);
    assert.equal(getModelIntelligenceScore("claude-sonnet-5-5-high"), 46.8);
    assert.equal(getModelIntelligenceScore("mimo-v2.6-pro"), 46.0);
    assert.equal(getModelIntelligenceScore("qwen3.8-max"), 45.4);
    assert.equal(getModelIntelligenceScore("muse-spark-1.3-contributor"), 45.0);
    assert.equal(getModelIntelligenceScore("deepseek-v4-flash-max"), 45.0);
    assert.equal(getModelIntelligenceScore("glm-5.2-max"), 45.0);
    assert.equal(getModelIntelligenceScore("kimi-k3-max"), 44.0);
    assert.equal(getModelIntelligenceScore("claude-haiku-4-5"), 43.4);
    assert.equal(getModelIntelligenceScore("gpt-6-sol-low"), 42.0);
    assert.equal(getModelIntelligenceScore("gemini-3.8-flash-tiered-high"), 41.0);
    assert.equal(getModelIntelligenceScore("claude-sonnet-5-5-medium"), 40.8);
    assert.equal(getModelIntelligenceScore("qwen3.8-flash-next"), 40.0);
    assert.equal(getModelIntelligenceScore("gpt-6-luna-high"), 38.4);
    assert.equal(getModelIntelligenceScore("mimo-v2.6-flash"), 37.9);
  });
});

describe("Price-cliff guardrail", () => {
  const pool = [
    { modelStr: "anthropic/claude-haiku-4-5", provider: "anthropic" },
    { modelStr: "anthropic/claude-sonnet-5-5-high", provider: "anthropic" },
  ];

  it("filters out haiku when trajectory exceeds the price cliff", () => {
    const envelope: RequestRoutingEnvelope = {
      requiredContextTokens: 0.7 * PRICE_CLIFF_TOKENS["claude-haiku-4-5"],
    };
    const survivors = filterTargetsByRequestEnvelope(pool, envelope);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].modelStr, "anthropic/claude-sonnet-5-5-high");
  });

  it("keeps haiku when trajectory stays within the price cliff", () => {
    const envelope: RequestRoutingEnvelope = {
      requiredContextTokens: 0.6 * PRICE_CLIFF_TOKENS["claude-haiku-4-5"],
    };
    const survivors = filterTargetsByRequestEnvelope(pool, envelope);
    assert.equal(survivors.length, 2);
  });
});

describe("extractRoutingEnvelope & comboStructure integration", () => {
  it("ignores non-plain body header fallbacks without throwing", () => {
    const baseline = { _omnirouteEnvelope: { taskRole: "implement" } };
    for (const key of ["headers", "_omnirouteHeaders"]) {
      for (const value of ["authorization: x", [], 5, new Date(0)]) {
        assert.deepEqual(
          extractRoutingEnvelope({ ...baseline, [key]: value }),
          extractRoutingEnvelope(baseline)
        );
      }
    }
  });

  it("accepts plain body header fallbacks and explicit Headers instances", () => {
    const headers = { "x-omniroute-task-role": "implement" };
    for (const value of [headers, Object.assign(Object.create(null), headers)]) {
      assert.equal(extractRoutingEnvelope({ headers: value })?.taskRole, "implement");
      assert.equal(extractRoutingEnvelope({ _omnirouteHeaders: value })?.taskRole, "implement");
    }
    assert.equal(extractRoutingEnvelope(null, new Headers(headers))?.taskRole, "implement");
  });

  for (const [label, value, expected] of [
    ["string", "kimi", []],
    ["object", {}, []],
    ["number", 5, []],
    ["mixed array", ["glm", 1, null, {}], ["glm"]],
  ] as const) {
    it(`cleans body excludeFamilies supplied as ${label}`, () => {
      const body = { _omnirouteEnvelope: { taskRole: "implement", excludeFamilies: value } };
      assert.deepEqual(extractRoutingEnvelope(body)?.excludeFamilies ?? [], expected);
      assert.deepEqual(
        extractRoutingEnvelope(body, { "x-omniroute-exclude-family": "kimi" })?.excludeFamilies,
        ["kimi", ...expected]
      );
    });
  }

  it("cleans non-string exclusions in directly supplied envelopes", () => {
    const targets = [{ modelStr: "glm-5.2-max" }, { modelStr: "kimi-k3-max" }];
    const envelope = {
      excludeFamilies: ["GLM", 1, null, {}],
    } as unknown as RequestRoutingEnvelope;
    assert.deepEqual(filterTargetsByRequestEnvelope(targets, envelope), [targets[1]]);
  });

  it("extracts a context-only header envelope and preserves body precedence", () => {
    const headers = { "x-omniroute-required-context": "128k" };
    assert.deepEqual(extractRoutingEnvelope(null, headers), { requiredContextTokens: 128000 });
    assert.deepEqual(extractRoutingEnvelope(null, new Headers(headers)), {
      requiredContextTokens: 128000,
    });
    assert.equal(
      extractRoutingEnvelope({ _omnirouteEnvelope: { requiredContextTokens: 42000 } }, headers)
        ?.requiredContextTokens,
      42000
    );
  });

  it("extracts envelope from body._omnirouteEnvelope", () => {
    const body = {
      messages: [{ role: "user", content: "review this PR" }],
      _omnirouteEnvelope: {
        taskRole: "review",
        authorModel: "agy/claude-sonnet-5-5-high",
      },
    };
    const envelope = extractRoutingEnvelope(body);
    assert.ok(envelope);
    assert.equal(envelope.taskRole, "review");
    assert.equal(envelope.authorModel, "agy/claude-sonnet-5-5-high");
  });

  it("merges headers and body._omnirouteEnvelope", () => {
    const body = {
      _omnirouteEnvelope: {
        taskRole: "review",
      },
    };
    const headers = {
      "x-omniroute-exclude-family": "gpt",
    };
    const envelope = extractRoutingEnvelope(body, headers);
    assert.ok(envelope);
    assert.equal(envelope.taskRole, "review");
    assert.deepEqual(envelope.excludeFamilies, ["gpt"]);
  });

  it("filters targets via filterTargetsByRequestCompatibility when envelope is present in body", () => {
    const targets: ResolvedComboTarget[] = [
      {
        stepId: "s1",
        modelStr: "agy/claude-sonnet-5-5-high",
        provider: "agy",
        executionKey: "agy:claude-sonnet-5-5-high",
        index: 0,
      },
      {
        stepId: "s2",
        modelStr: "mimo/mimo-v2.6-pro",
        provider: "mimo",
        executionKey: "mimo:mimo-v2.6-pro",
        index: 1,
      },
    ];
    const body = {
      messages: [{ role: "user", content: "Review code" }],
      _omnirouteEnvelope: {
        taskRole: "review",
        authorModel: "agy/claude-sonnet-5-5-high",
      },
    };
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const filtered = filterTargetsByRequestCompatibility(targets, body, noopLogger);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].modelStr, "mimo/mimo-v2.6-pro");
  });

  it("returns empty array in filterTargetsByRequestCompatibility when review excludes all targets", () => {
    const targets: ResolvedComboTarget[] = [
      {
        stepId: "s1",
        modelStr: "agy/claude-sonnet-5-5-high",
        provider: "agy",
        executionKey: "agy:claude-sonnet-5-5-high",
        index: 0,
      },
    ];
    const body = {
      messages: [{ role: "user", content: "Review code" }],
      _omnirouteEnvelope: {
        taskRole: "review",
        authorModel: "agy/claude-sonnet-5-5-high",
      },
    };
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const filtered = filterTargetsByRequestCompatibility(targets, body, noopLogger);
    assert.deepEqual(filtered, []);
  });
});

describe("advisory risk and effort envelope fields", () => {
  it("carries valid headers and drops invalid values", () => {
    for (const [risk, effort] of [
      ["high", "max"],
      ["invalid", "invalid"],
    ]) {
      const headers = {
        "X-OmniRoute-Task-Role": "implement",
        "X-OmniRoute-Risk": risk,
        "X-OmniRoute-Effort": effort,
      };
      for (const input of [headers, new Headers(headers)]) {
        const envelope = extractRoutingEnvelope(null, input);
        assert.equal(envelope?.taskRole, "implement");
        assert.equal(envelope?.risk, risk === "high" ? "high" : undefined);
        assert.equal(envelope?.effort, effort === "max" ? "max" : undefined);
      }
    }
  });
});
