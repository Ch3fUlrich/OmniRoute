// A usage window with no valid `total` (Vertex self-tracked spend) has an UNKNOWN
// remaining percentage. It must be null, never 0%, and must not exhaust the connection.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const Q = "../../src/domain/quotaCache.ts";
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("quotaCache null-safety for total-less windows", () => {
  before(async () => (await import(Q)).__clearForTests());
  after(async () => (await import(Q)).__clearForTests());

  test("spend-only window (used, no total) leaves remaining null and not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, getQuotaWindowStatus, isAccountQuotaExhausted } =
      await import(Q);
    setQuotaCache("qns-spend", "vertex", { spend: { used: 1.5, resetAt: null } });
    assert.equal(getQuotaCache("qns-spend").quotas.spend.remainingPercentage, null);
    assert.equal(getQuotaCache("qns-spend").exhausted, false);
    assert.equal(isAccountQuotaExhausted("qns-spend"), false);
    const st = getQuotaWindowStatus("qns-spend", "spend");
    assert.equal(st.remainingPercentage, null);
    assert.equal(st.reachedThreshold, false);
  });

  test("real 0% window stays exhausted next to a total-less one (B + C)", async () => {
    const { setQuotaCache, getQuotaCache } = await import(Q);
    setQuotaCache("qns-bc", "x", {
      a: { used: 100, total: 100, resetAt: future() },
      spend: { used: 3 },
    });
    assert.equal(getQuotaCache("qns-bc").exhausted, true);
  });

  test("50% + 0% is not exhausted; 0% + 0% is; A + C is not", async () => {
    const { setQuotaCache, getQuotaCache } = await import(Q);
    setQuotaCache("qns-5", "x", {
      a: { used: 50, total: 100, resetAt: future() },
      b: { used: 100, total: 100, resetAt: future() },
    });
    assert.equal(getQuotaCache("qns-5").exhausted, false);
    setQuotaCache("qns-00", "x", {
      a: { used: 100, total: 100, resetAt: future() },
      b: { used: 100, total: 100, resetAt: future() },
    });
    assert.equal(getQuotaCache("qns-00").exhausted, true);
    setQuotaCache("qns-ac", "x", {
      a: { used: 60, total: 100, resetAt: future() },
      spend: { used: 3 },
    });
    assert.equal(getQuotaCache("qns-ac").exhausted, false);
  });

  test("no window at all, and overuse / near-cap", async () => {
    const { setQuotaCache, getQuotaCache } = await import(Q);
    setQuotaCache("qns-empty", "x", {});
    assert.equal(getQuotaCache("qns-empty").exhausted, false);
    setQuotaCache("qns-over", "x", { a: { used: 150, total: 100, resetAt: future() } });
    assert.equal(getQuotaCache("qns-over").quotas.a.remainingPercentage, -50);
    assert.equal(getQuotaCache("qns-over").exhausted, true);
    setQuotaCache("qns-near", "x", { a: { used: 999, total: 1000, resetAt: future() } });
    assert.equal(getQuotaCache("qns-near").quotas.a.remainingPercentage, 0);
  });
});
