/**
 * CLI access-token scopes — hierarchical access scopes and limited purpose-specific scopes.
 *
 * These tokens authorize the `omniroute` CLI (and dashboard) to run *management*
 * commands against a (possibly remote) OmniRoute server. They are distinct from
 * inference API keys (`api_keys`), which authorize `/v1/chat/completions` traffic.
 *
 * Hierarchy (admin ⊃ write ⊃ read):
 *   - read  : list/inspect only (models list, providers status, logs, usage, cost)
 *   - write : read + configure/apply (setup-codex, keys add, config set, combo edit)
 *   - admin : write + sensitive management (tokens create/revoke, providers add,
 *             services install/start, policy, oauth)
 *
 * Safe-method reads (GET/HEAD/OPTIONS) keep the base method policy, including providers
 * list, client, models and expiration, resilience/model-cooldowns, monitoring health,
 * and /api/usage/quota (connection resetAt). Sensitive admin surfaces and key reveal
 * remain admin; provider connection-by-id reads require admin because they may reveal
 * credentials. Mutations retain write/admin requirements; no prefix-wide exceptions.
 *
 * Limited scopes (purpose-specific, outside the read<write<admin hierarchy):
 *   - logs:read : read-only access strictly to /api/usage/call-logs and /api/cli/whoami.
 *                 Requires minute-based expiration.
 *
 * Loopback-only routes that spawn processes (`isLocalOnlyPath`) are NEVER reachable
 * by a remote token regardless of scope — that enforcement happens before auth.
 */

export const ACCESS_SCOPES = ["read", "write", "admin"] as const;

export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const LIMITED_SCOPES = ["logs:read"] as const;

export type LimitedScope = (typeof LIMITED_SCOPES)[number];

export const TOKEN_SCOPES = [...ACCESS_SCOPES, ...LIMITED_SCOPES] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export interface ScopeGrant {
  method: string;
  path: string;
}

/** Route grants permitted for limited purpose-specific scopes. */
export const LIMITED_SCOPE_GRANTS: Record<LimitedScope, readonly ScopeGrant[]> = {
  "logs:read": [
    { method: "GET", path: "/api/usage/call-logs" },
    { method: "GET", path: "/api/cli/whoami" },
  ],
};

/** Numeric rank for hierarchy comparisons. Higher = more privileged. */
const SCOPE_RANK: Record<AccessScope, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** Type guard: is `value` one of the three valid scopes? */
export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === "string" && (ACCESS_SCOPES as readonly string[]).includes(value);
}

/** Type guard: is `value` one of the limited scopes outside the hierarchy? */
export function isLimitedScope(value: unknown): value is LimitedScope {
  return typeof value === "string" && (LIMITED_SCOPES as readonly string[]).includes(value);
}

/** Type guard: is `value` any valid token scope (hierarchical or limited)? */
export function isTokenScope(value: unknown): value is TokenScope {
  return isAccessScope(value) || isLimitedScope(value);
}

/**
 * True when a token holding `have` is allowed to perform an action that requires
 * `need`. Hierarchy is inclusive: an `admin` token satisfies `write` and `read`;
 * a `write` token satisfies `read`. Unknown scopes never satisfy anything.
 */
export function scopeSatisfies(have: unknown, need: AccessScope): boolean {
  if (!isAccessScope(have)) return false;
  if (!isAccessScope(need)) return false;
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

/**
 * Normalize an arbitrary input into a valid scope, falling back to the safest
 * default (`read`) when the value is missing or invalid. Used when reading a
 * stored/declared scope that must never silently widen privileges.
 */
export function normalizeScope(value: unknown, fallback: AccessScope = "read"): AccessScope {
  return isAccessScope(value) ? value : fallback;
}
