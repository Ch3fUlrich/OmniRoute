import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("quota-cache null-safety for total-less (Vertex spend) windows", () => {
  beforeEach(async () => {
    const { __clearForTests } = await import("../../src/domain/quotaCache.ts");
    __clearForTests();
  });

  test("total>0 with 40% remaining -> 40 / not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, getQuotaWindowStatus, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-40pct";
    setQuotaCache(conn, "vertex", { spend: { used: 60, total: 100, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, 40);
    assert.equal(isAccountQuotaExhausted(conn), false);
    const status = getQuotaWindowStatus(conn, "spend");
    assert.equal(status?.remainingPercentage, 40);
    assert.equal(status?.usedPercentage, 60);
    assert.equal(status?.reachedThreshold, false);
  });

  test("0% remaining -> 0 / exhausted", async () => {
    const { setQuotaCache, getQuotaCache, getQuotaWindowStatus, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-0pct";
    setQuotaCache(conn, "vertex", { spend: { used: 100, total: 100, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, 0);
    assert.equal(isAccountQuotaExhausted(conn), true);
    const status = getQuotaWindowStatus(conn, "spend");
    assert.equal(status?.remainingPercentage, 0);
    assert.equal(status?.reachedThreshold, true);
  });

  test("total absent -> null / not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, getQuotaWindowStatus, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-no-total";
    setQuotaCache(conn, "vertex", { spend: { used: 5, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, null);
    assert.equal(isAccountQuotaExhausted(conn), false);
    const status = getQuotaWindowStatus(conn, "spend");
    assert.equal(status?.remainingPercentage, null);
    assert.equal(status?.usedPercentage, null);
    assert.equal(status?.reachedThreshold, false);
  });

  test("total 0 -> null / not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-total-zero";
    setQuotaCache(conn, "vertex", { spend: { used: 5, total: 0, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, null);
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("total NaN -> null / not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-total-nan";
    setQuotaCache(conn, "vertex", { spend: { used: 5, total: NaN, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, null);
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("total negative -> null / not exhausted", async () => {
    const { setQuotaCache, getQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-total-neg";
    setQuotaCache(conn, "vertex", { spend: { used: 5, total: -100, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, null);
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("{} -> not exhausted", async () => {
    const { setQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-empty";
    setQuotaCache(conn, "vertex", {});
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("50% + 0% -> not exhausted", async () => {
    const { setQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-50-0";
    setQuotaCache(conn, "vertex", {
      a: { used: 50, total: 100, resetAt: null },
      b: { used: 100, total: 100, resetAt: null },
    });
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("0% + 0% -> exhausted", async () => {
    const { setQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-0-0";
    setQuotaCache(conn, "vertex", {
      a: { used: 100, total: 100, resetAt: null },
      b: { used: 200, total: 200, resetAt: null },
    });
    assert.equal(isAccountQuotaExhausted(conn), true);
  });

  test("0% + total-less -> exhausted (null window ignored)", async () => {
    const { setQuotaCache, getQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-0-plus-unknown";
    setQuotaCache(conn, "vertex", {
      a: { used: 100, total: 100, resetAt: null },
      spend: { used: 5, resetAt: null },
    });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, null);
    assert.equal(isAccountQuotaExhausted(conn), true);
  });

  test("40% + total-less -> not exhausted", async () => {
    const { setQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-40-plus-unknown";
    setQuotaCache(conn, "vertex", {
      a: { used: 60, total: 100, resetAt: null },
      spend: { used: 5, resetAt: null },
    });
    assert.equal(isAccountQuotaExhausted(conn), false);
  });

  test("used150/total100 -> -50 / exhausted", async () => {
    const { setQuotaCache, getQuotaCache, getQuotaWindowStatus, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-overused";
    setQuotaCache(conn, "vertex", { spend: { used: 150, total: 100, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, -50);
    assert.equal(isAccountQuotaExhausted(conn), true);
    const status = getQuotaWindowStatus(conn, "spend");
    assert.equal(status?.reachedThreshold, true);
  });

  test("used999/total1000 -> 0 / exhausted", async () => {
    const { setQuotaCache, getQuotaCache, isAccountQuotaExhausted } =
      await import("../../src/domain/quotaCache.ts");
    const conn = "nullsafe-round-zero";
    setQuotaCache(conn, "vertex", { spend: { used: 999, total: 1000, resetAt: null } });
    assert.equal(getQuotaCache(conn)?.quotas["spend"]?.remainingPercentage, 0);
    assert.equal(isAccountQuotaExhausted(conn), true);
  });
});
