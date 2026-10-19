/**
 * Request routing envelope and cross-family review filter.
 *
 * Pure, self-contained leaf module providing cross-family review enforcement,
 * price-cliff guardrails, and intelligence thresholds for combo routing.
 */

import { detectModelFamily } from "../autoCombo/modelFamily.ts";
import { extractRequestOverrides } from "../autoCombo/requestControls.ts";

export interface RequestRoutingEnvelope {
  taskRole?: "implement" | "review" | "orchestrate" | "drive";
  excludeFamilies?: string[];
  authorModel?: string;
  minIntelligence?: number;
  risk?: "low" | "normal" | "high" | "critical";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  requiredContextTokens?: number;
}

export const BUILT_IN_INTELLIGENCE_INDEX: Readonly<Record<string, number>> = {
  "claude-opus-5-5-high": 57.6,
  "gemini-4-argon-high": 53.0,
  "gpt-6-astra-max": 53.0,
  "gpt-6-sol-max": 52.0,
  "claude-sonnet-5-5-xhigh": 51.9,
  "gpt-6-sol-xhigh": 51.0,
  "gpt-6-sol-high": 50.0,
  "gpt-6-sol-medium": 48.0,
  "claude-sonnet-5-5-high": 46.8,
  "mimo-v2.6-pro": 46.0,
  "qwen3.8-max": 45.4,
  "muse-spark-1.3-contributor": 45.0,
  "deepseek-v4-flash-max": 45.0,
  "glm-5.2-max": 45.0,
  "kimi-k3-max": 44.0,
  "claude-haiku-4-5": 43.4,
  "gpt-6-sol-low": 42.0,
  "gemini-3.8-flash-tiered-high": 41.0,
  "claude-sonnet-5-5-medium": 40.8,
  "qwen3.8-flash-next": 40.0,
  "gpt-6-luna-high": 38.4,
  "mimo-v2.6-flash": 37.9,
};

export const PRICE_CLIFF_TOKENS: Readonly<Record<string, number>> = {
  "claude-haiku-4-5": 100000,
  "claude-haiku-5-5-high": 100000,
};

export function getModelIntelligenceScore(
  modelStr: string,
  customMap?: ReadonlyMap<string, number>
): number | null {
  if (!modelStr || typeof modelStr !== "string") return null;
  const trimmed = modelStr.trim();
  const bare = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  if (customMap) {
    if (customMap.has(trimmed)) return customMap.get(trimmed)!;
    if (customMap.has(bare)) return customMap.get(bare)!;
    if (customMap.has(trimmed.toLowerCase())) return customMap.get(trimmed.toLowerCase())!;
    if (customMap.has(bare.toLowerCase())) return customMap.get(bare.toLowerCase())!;
  }
  const lowerBare = bare.toLowerCase();
  const lowerTrimmed = trimmed.toLowerCase();
  if (lowerBare in BUILT_IN_INTELLIGENCE_INDEX) return BUILT_IN_INTELLIGENCE_INDEX[lowerBare];
  if (lowerTrimmed in BUILT_IN_INTELLIGENCE_INDEX) return BUILT_IN_INTELLIGENCE_INDEX[lowerTrimmed];
  return null;
}

export function extractRoutingEnvelope(
  body?: Record<string, unknown> | null,
  headers?: Record<string, string | undefined> | Headers | null
): RequestRoutingEnvelope | null {
  const effectiveHeaders =
    headers ??
    ((body && typeof body === "object" && ("headers" in body || "_omnirouteHeaders" in body))
      ? (body.headers ?? body._omnirouteHeaders)
      : null);
  const fromHeaders = effectiveHeaders ? extractRequestOverrides(effectiveHeaders) : {};

  let fromBody: Partial<RequestRoutingEnvelope> = {};
  if (
    body &&
    typeof body === "object" &&
    "_omnirouteEnvelope" in body &&
    body._omnirouteEnvelope &&
    typeof body._omnirouteEnvelope === "object"
  ) {
    fromBody = body._omnirouteEnvelope as Partial<RequestRoutingEnvelope>;
  }

  const envelope: RequestRoutingEnvelope = {
    ...fromHeaders,
    ...fromBody,
  };

  const combinedExclude = new Set<string>([
    ...(fromHeaders.excludeFamilies ?? []),
    ...(fromBody.excludeFamilies ?? []),
  ]);
  if (combinedExclude.size > 0) {
    envelope.excludeFamilies = Array.from(combinedExclude);
  }

  const hasAnyField =
    envelope.taskRole !== undefined ||
    (envelope.excludeFamilies !== undefined && envelope.excludeFamilies.length > 0) ||
    envelope.authorModel !== undefined ||
    envelope.minIntelligence !== undefined ||
    envelope.risk !== undefined ||
    envelope.effort !== undefined ||
    envelope.requiredContextTokens !== undefined;

  return hasAnyField ? envelope : null;
}

export function shouldBypassSessionStickiness(
  envelope: RequestRoutingEnvelope | null | undefined
): boolean {
  if (!envelope) return false;
  return envelope.taskRole === "review" || (envelope.excludeFamilies?.length ?? 0) > 0;
}

export function clampSafeEffortForModel(
  modelStr: string,
  effort: string | null | undefined
): string | null {
  if (effort === "max" && /claude-sonnet-5-5/i.test(modelStr)) {
    return "xhigh";
  }
  return effort ?? null;
}

export function isGatedCodexTarget(modelStr: string, provider?: string | null): boolean {
  const lower = (modelStr || "").toLowerCase();
  const prov = (provider || "").toLowerCase();
  if (prov === "cxa" || lower.startsWith("cxa/")) {
    return !lower.includes("gpt-6-luna") && !lower.includes("/luna");
  }
  return false;
}

export function filterTargetsByRequestEnvelope<T extends { modelStr: string; provider?: string }>(
  targets: T[],
  envelope: RequestRoutingEnvelope | null | undefined
): T[] {
  if (!envelope || targets.length === 0) return targets;

  // 0. Codex ACP luna-only gating (reject cxa/gpt-6-astra-* and cxa/gpt-6-sol-*)
  const ungated = targets.filter((t) => !isGatedCodexTarget(t.modelStr, t.provider));
  let filtered = ungated.length > 0 || envelope.taskRole === "review" ? ungated : targets;

  // 1. Hard Cross-Family Exclusion
  const excluded = new Set<string>(
    (envelope.excludeFamilies ?? []).map((f) => f.toLowerCase())
  );
  for (const f of Array.from(excluded)) {
    if (f.startsWith("claude")) excluded.add("claude");
  }
  if (envelope.authorModel) {
    const authorFamily = detectModelFamily(envelope.authorModel);
    if (authorFamily) {
      excluded.add(authorFamily.toLowerCase());
      if (authorFamily.startsWith("claude")) excluded.add("claude");
    }
  }

  if (excluded.size > 0) {
    const nonExcluded = filtered.filter((target) => {
      const family = detectModelFamily(target.modelStr);
      if (envelope.taskRole === "review") {
        // Fail-closed on review: unknown family cannot prove cross-family independence
        if (!family) return false;
        const famLower = family.toLowerCase();
        if (excluded.has(famLower)) return false;
        if (famLower.startsWith("claude") && excluded.has("claude")) return false;
        return true;
      }
      if (!family) return true;
      const famLower = family.toLowerCase();
      if (excluded.has(famLower)) return false;
      if (famLower.startsWith("claude") && excluded.has("claude")) return false;
      return true;
    });
    if (envelope.taskRole === "review") {
      filtered = nonExcluded;
    } else {
      filtered = nonExcluded.length > 0 ? nonExcluded : filtered;
    }
  }

  // 2. Price-Cliff Guardrail
  if (
    envelope.requiredContextTokens !== undefined &&
    envelope.requiredContextTokens > 0 &&
    filtered.length > 1
  ) {
    const nonCliff = filtered.filter((target) => {
      const bare = target.modelStr.includes("/")
        ? target.modelStr.slice(target.modelStr.lastIndexOf("/") + 1).toLowerCase()
        : target.modelStr.toLowerCase();
      const cliff = PRICE_CLIFF_TOKENS[bare] ?? PRICE_CLIFF_TOKENS[target.modelStr.toLowerCase()];
      if (cliff !== undefined && envelope.requiredContextTokens! > cliff) {
        return false;
      }
      return true;
    });
    if (nonCliff.length > 0) {
      filtered = nonCliff;
    }
  }

  // 3. Min-Intelligence Filter
  if (
    envelope.minIntelligence !== undefined &&
    envelope.minIntelligence > 0 &&
    filtered.length > 0
  ) {
    const minIntel = envelope.minIntelligence;
    const qualifying = filtered.filter((target) => {
      const score = getModelIntelligenceScore(target.modelStr);
      return score === null || score >= minIntel;
    });
    if (qualifying.length > 0) {
      filtered = qualifying;
    } else {
      filtered = [...filtered].sort((a, b) => {
        const scoreA = getModelIntelligenceScore(a.modelStr) ?? -Infinity;
        const scoreB = getModelIntelligenceScore(b.modelStr) ?? -Infinity;
        return scoreB - scoreA;
      });
    }
  }

  return filtered;
}

export function buildSelectedTargetEnvelopeHeaders(target: {
  modelStr: string;
  provider?: string | null;
}): Record<string, string> {
  return {
    "X-OmniRoute-Selected-Model": target.modelStr,
    "X-OmniRoute-Selected-Provider": target.provider || "",
    "X-OmniRoute-Selected-Family": detectModelFamily(target.modelStr) || "unknown",
  };
}
