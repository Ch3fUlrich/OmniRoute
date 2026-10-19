import { isFreeModel } from "@/shared/utils/freeModels";
import type { CatalogTestResult } from "./catalogTestStorage";
import { getModelTestKey } from "./catalogTestStorage";

export interface CatalogModel {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  custom?: boolean;
  free?: boolean;
  capabilities?: Record<string, unknown>;
  context_length?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
  benchmarks?: {
    aaIntelligence?: number | null;
    codingIndex?: number | null;
    agenticIndex?: number | null;
    terminalBench?: number | null;
    deepswe?: number | null;
    scicode?: number | null;
    verifiedTokPerS?: number | null;
    costPerTaskUsd?: number | null;
    priceCliffTokens?: number | null;
    maxSafeEffort?: string | null;
    effortCaveat?: string | null;
  } | null;
}

export interface CatalogModelRow extends CatalogModel {
  providerId: string;
  provider: string;
  aaIntelligence?: number | null;
  codingScore?: number | null;
  verifiedTokPerS?: number | null;
  costPerTaskUsd?: number | null;
  effortCaveat?: string | null;
}

export type CatalogSortField =
  | "provider"
  | "id"
  | "type"
  | "context_length"
  | "max_output_tokens"
  | "aaIntelligence"
  | "codingScore"
  | "verifiedTokPerS"
  | "costPerTaskUsd";
export type CatalogSortDirection = "asc" | "desc";

export interface CatalogFilters {
  query: string;
  providerId: string;
  type: string;
  subtype?: string;
  capability?: string;
  minContextLength?: number;
  minMaxOutputTokens?: number;
  pricing?: string; // "all" | "free" | "paid"
  providerHealth?: string; // "all" | "healthy" | "degraded" | "down"
  testResult?: string; // "all" | "untested" | "ok" | "slow" | "error"
}

export interface CatalogFilterOptions {
  providerHealthMap?: Record<string, "healthy" | "degraded" | "down">;
  testResults?: Record<string, CatalogTestResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Convert the provider-grouped API payload into stable rows for the dashboard table. */
export function flattenCatalog(catalog: unknown): CatalogModelRow[] {
  if (!isRecord(catalog)) return [];

  const rows: CatalogModelRow[] = [];
  for (const [providerId, rawBucket] of Object.entries(catalog)) {
    if (!isRecord(rawBucket) || !Array.isArray(rawBucket.models)) continue;
    const provider = typeof rawBucket.provider === "string" ? rawBucket.provider : providerId;

    for (const rawModel of rawBucket.models) {
      if (!isRecord(rawModel) || typeof rawModel.id !== "string") continue;
      const id = rawModel.id;

      let aaIntelligence: number | null = null;
      let codingScore: number | null = null;
      let verifiedTokPerS: number | null = null;
      let costPerTaskUsd: number | null = null;
      let effortCaveat: string | null = null;

      if (isRecord(rawModel.benchmarks)) {
        const b = rawModel.benchmarks;
        if (typeof b.aaIntelligence === "number") aaIntelligence = b.aaIntelligence;
        if (typeof b.codingScore === "number") {
          codingScore = b.codingScore;
        } else if (typeof b.codingIndex === "number") {
          codingScore = b.codingIndex;
        } else if (typeof b.deepswe === "number") {
          codingScore = b.deepswe;
        }
        if (typeof b.verifiedTokPerS === "number") verifiedTokPerS = b.verifiedTokPerS;
        if (typeof b.costPerTaskUsd === "number") costPerTaskUsd = b.costPerTaskUsd;
        if (typeof b.effortCaveat === "string") effortCaveat = b.effortCaveat;
      }

      rows.push({
        providerId,
        provider,
        id,
        name: typeof rawModel.name === "string" ? rawModel.name : id,
        type: typeof rawModel.type === "string" ? rawModel.type : "unknown",
        ...(typeof rawModel.subtype === "string" ? { subtype: rawModel.subtype } : {}),
        ...(rawModel.custom === true ? { custom: true } : {}),
        ...(rawModel.free === true ? { free: true } : {}),
        ...(isRecord(rawModel.capabilities) ? { capabilities: rawModel.capabilities } : {}),
        ...(typeof rawModel.context_length === "number"
          ? { context_length: rawModel.context_length }
          : {}),
        ...(typeof rawModel.max_output_tokens === "number"
          ? { max_output_tokens: rawModel.max_output_tokens }
          : {}),
        ...(Array.isArray(rawModel.input_modalities)
          ? { input_modalities: rawModel.input_modalities.filter(isString) }
          : {}),
        ...(Array.isArray(rawModel.output_modalities)
          ? { output_modalities: rawModel.output_modalities.filter(isString) }
          : {}),
        ...(Array.isArray(rawModel.supported_endpoints)
          ? { supported_endpoints: rawModel.supported_endpoints.filter(isString) }
          : {}),
        aaIntelligence,
        codingScore,
        verifiedTokPerS,
        costPerTaskUsd,
        effortCaveat,
        ...(isRecord(rawModel.benchmarks) ? { benchmarks: rawModel.benchmarks as any } : {}),
      });
    }
  }

  return rows;
}

export const flattenCatalogModels = flattenCatalog;

/** Boolean flags contribute their key; list values contribute every non-blank string entry. */
function addCapabilityNames(caps: Set<string>, capabilities: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === true) {
      caps.add(key.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          caps.add(item.toLowerCase());
        }
      }
    }
  }
}

export function extractCatalogCapabilities(models: CatalogModelRow[]): string[] {
  const caps = new Set<string>();
  for (const model of models) {
    if (model.capabilities) {
      addCapabilityNames(caps, model.capabilities);
    }
  }
  return [...caps].sort((left, right) => left.localeCompare(right));
}

function modelHasCapability(model: CatalogModelRow, targetCap: string): boolean {
  if (!model.capabilities) return false;
  const target = targetCap.toLowerCase();
  for (const [key, value] of Object.entries(model.capabilities)) {
    if (key.toLowerCase() === target && value === true) return true;
    if (Array.isArray(value)) {
      if (value.some((item) => typeof item === "string" && item.toLowerCase() === target)) {
        return true;
      }
    }
  }
  return false;
}

export function isModelFree(model: CatalogModelRow): boolean {
  if (model.free === true) return true;
  try {
    return isFreeModel(model.providerId, { id: model.id });
  } catch {
    return false;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function searchableText(model: CatalogModelRow): string {
  return [
    model.provider,
    model.providerId,
    model.id,
    model.name,
    model.type,
    model.subtype,
    ...Object.entries(model.capabilities ?? {}).flatMap(([key, value]) => [
      key,
      ...(Array.isArray(value) ? value.filter(isString) : []),
    ]),
    ...(model.input_modalities ?? []),
    ...(model.output_modalities ?? []),
    ...(model.supported_endpoints ?? []),
  ]
    .filter(isString)
    .join(" ")
    .toLocaleLowerCase();
}

/** Optional select filters are inactive while unset or set to "all". */
function isActiveChoice(value: string | undefined): value is string {
  return Boolean(value) && value !== "all";
}

function matchesSubtype(model: CatalogModelRow, subtype: string | undefined): boolean {
  return !isActiveChoice(subtype) || model.subtype === subtype;
}

function matchesCapability(model: CatalogModelRow, capability: string | undefined): boolean {
  return !isActiveChoice(capability) || modelHasCapability(model, capability);
}

/** A set minimum hides rows whose value is unknown or below it; an unset minimum hides none. */
function meetsMinimum(value: number | undefined, minimum: number | undefined): boolean {
  if (typeof minimum !== "number" || Number.isNaN(minimum)) return true;
  if (typeof value !== "number" || value < minimum) return false;
  return true;
}

function matchesPricing(model: CatalogModelRow, pricing: string | undefined): boolean {
  if (!isActiveChoice(pricing)) return true;
  const free = isModelFree(model);
  if (pricing === "free" && !free) return false;
  if (pricing === "paid" && free) return false;
  return true;
}

function matchesProviderHealth(
  model: CatalogModelRow,
  providerHealth: string | undefined,
  providerHealthMap: Record<string, "healthy" | "degraded" | "down">
): boolean {
  if (!isActiveChoice(providerHealth)) return true;
  const health = providerHealthMap[model.providerId] ?? "healthy";
  return health === providerHealth;
}

function matchesModelTestResult(
  model: CatalogModelRow,
  testResult: string | undefined,
  testResults: Record<string, CatalogTestResult>
): boolean {
  if (!isActiveChoice(testResult)) return true;
  const test = testResults[getModelTestKey(model.providerId, model.id)];
  const resultStatus = test ? test.status : "untested";
  return resultStatus === testResult;
}

export function filterCatalogModels(
  models: CatalogModelRow[],
  filters: CatalogFilters,
  options: CatalogFilterOptions = {}
): CatalogModelRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const { providerHealthMap = {}, testResults = {} } = options;

  return models.filter((model) => {
    if (filters.providerId !== "all" && model.providerId !== filters.providerId) return false;
    if (filters.type !== "all" && model.type !== filters.type) return false;
    if (!matchesSubtype(model, filters.subtype)) return false;
    if (!matchesCapability(model, filters.capability)) return false;
    if (!meetsMinimum(model.context_length, filters.minContextLength)) return false;
    if (!meetsMinimum(model.max_output_tokens, filters.minMaxOutputTokens)) return false;
    if (!matchesPricing(model, filters.pricing)) return false;
    if (!matchesProviderHealth(model, filters.providerHealth, providerHealthMap)) return false;
    if (!matchesModelTestResult(model, filters.testResult, testResults)) return false;
    return query === "" || searchableText(model).includes(query);
  });
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

export function sortCatalogModels(
  models: CatalogModelRow[],
  field: CatalogSortField,
  direction: CatalogSortDirection
): CatalogModelRow[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...models].sort((left, right) => {
    const leftValue = left[field];
    const rightValue = right[field];

    const isNumericField =
      field === "context_length" ||
      field === "max_output_tokens" ||
      field === "aaIntelligence" ||
      field === "codingScore" ||
      field === "verifiedTokPerS" ||
      field === "costPerTaskUsd";

    if (isNumericField || typeof leftValue === "number" || typeof rightValue === "number") {
      const leftNum = typeof leftValue === "number" ? leftValue : null;
      const rightNum = typeof rightValue === "number" ? rightValue : null;

      // Keep unknown/null/undefined values last regardless of direction; absence is not zero.
      if (leftNum === null && rightNum === null) {
        // Fall through to secondary tiebreaker
      } else if (leftNum === null) {
        return 1;
      } else if (rightNum === null) {
        return -1;
      } else if (leftNum !== rightNum) {
        return (leftNum - rightNum) * multiplier;
      }
    } else {
      const comparison = compareText(String(leftValue ?? ""), String(rightValue ?? ""));
      if (comparison !== 0) return comparison * multiplier;
    }

    return compareText(left.providerId, right.providerId) || compareText(left.id, right.id);
  });
}

export function getCatalogPage<T>(
  rows: T[],
  requestedPage: number,
  requestedPageSize: number
): { rows: T[]; page: number; pageCount: number } {
  const pageSize =
    Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 50;
  const pageCount = Math.ceil(rows.length / pageSize);
  if (pageCount === 0) return { rows: [], page: 0, pageCount: 0 };

  const safePage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0;
  const page = Math.min(Math.max(0, safePage), pageCount - 1);
  return {
    rows: rows.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pageCount,
  };
}
