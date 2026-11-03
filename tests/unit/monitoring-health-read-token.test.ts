/**
 * r3 (D-3681): hermetic guard for the read-scope CLI token contract on
 * GET /api/monitoring/health — a `read`-scoped token must receive the detailed
 * payload whose `circuitBreakers[]` entries carry `retryAfterMs` retry timing
 * (the shape `check:pack-boot` and CLI monitors consume). Follows the
 * monitoring-health-public-view read-scope pattern, but is standalone: its own
 * tmp DATA_DIR and its own breaker registration, so it shares no state with any
 * other test file or ordering.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-health-read-token-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/monitoring/health/route.ts");
const { createAccessToken } = await import("../../src/lib/db/accessTokens.ts");
const { getCircuitBreaker, resetAllCircuitBreakers } = await import(
  "../../src/shared/utils/circuitBreaker.ts"
);

test.after(() => {
  // Dispose the breaker this file registered and restore DATA_DIR so an
  // isolation=none run cannot inherit either from this file.
  resetAllCircuitBreakers();
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("read-scope CLI token: GET /api/monitoring/health → 200 with circuitBreakers[] retryAfterMs", async () => {
  // Register a breaker so the array is non-empty even in a fresh process.
  getCircuitBreaker("health-read-token-r3");
  route.__test_resetMonitoringHealthPayloadCache();
  const { secret } = createAccessToken({ name: "health-read-token-r3", scope: "read" });
  const res = await route.GET(
    new Request("http://localhost/api/monitoring/health", {
      headers: { authorization: `Bearer ${secret}` },
    }) as unknown as NextRequest
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    circuitBreakers?: Array<{ provider?: unknown; retryAfterMs?: unknown }>;
  };
  assert.ok(Array.isArray(body.circuitBreakers), "read token must see the circuitBreakers array");
  // Assert the retry-timing contract on the breaker THIS test registers, by
  // name (the payload carries the registered name in `provider`): unrelated
  // module-registered entries must not be able to fail (or satisfy) it.
  const registered = body.circuitBreakers.find(
    (breaker) => breaker.provider === "health-read-token-r3"
  );
  assert.ok(registered, "the breaker registered by this test must be listed by name");
  assert.equal(
    typeof registered.retryAfterMs,
    "number",
    "the registered breaker carries numeric retryAfterMs retry timing"
  );
  // Global shape check: every listed entry is breaker-shaped.
  for (const breaker of body.circuitBreakers) {
    assert.equal(typeof breaker.provider, "string", "every breaker entry is named");
    assert.ok("retryAfterMs" in breaker, "every breaker entry exposes retryAfterMs");
  }
});
