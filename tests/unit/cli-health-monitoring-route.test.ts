import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runHealthCommand, runHealthComponentsCommand } from "../../bin/cli/commands/health.mjs";

// Regression test for GH #6677: `omniroute health` calls GET /api/health, but the
// real server only implements GET /api/monitoring/health (plus the sub-routes
// /api/health/degradation and /api/health/ping). This stub server mimics that
// exact real-world shape: /api/monitoring/health responds 200 with a healthy
// payload, everything else (including /api/health) 404s.
//
// Expectation once fixed: runHealthCommand() should hit /api/monitoring/health
// and return exit code 0.

let server: http.Server;
let baseUrl: string;
let arrayOnly = false;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/monitoring/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          version: "3.8.47",
          uptime: 123,
          activeConnections: 0,
          circuitBreakers: [{ provider: "fixture", state: "OPEN", retryAfterMs: 1000 }],
          circuitBreakerSummary: arrayOnly
            ? undefined
            : { open: 1, halfOpen: 0, degraded: 0, closed: 3, total: 4 },
          memoryUsage: { rss: 1000, heapUsed: 500 },
        })
      );
      return;
    }
    // Everything else, including the legacy /api/health the CLI used to call,
    // 404s — matching the real deployed route tree (only
    // app/api/health/degradation and app/api/health/ping exist on disk).
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  process.env.OMNIROUTE_BASE_URL = baseUrl;
});

test("health views use aggregate counts rather than treating the breaker array as counts", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assert.equal(await runHealthCommand({ verbose: true }), 0);
    assert.ok(lines.some((line) => /closed.*3/.test(line)));
    assert.ok(lines.some((line) => /open.*1/.test(line)));
    lines.length = 0;
    assert.equal(await runHealthComponentsCommand({}), 0);
    assert.ok(lines.some((line) => /closed.*3/.test(line)));
    assert.ok(!lines.some((line) => line.includes("unknown")));
    assert.ok(lines.some((line) => line.includes("aggregate counts")));
    assert.ok(!lines.some((line) => line.includes("total")));
    arrayOnly = true;
    lines.length = 0;
    assert.equal(await runHealthCommand({ verbose: true }), 0);
    assert.ok(lines.some((line) => /open.*1/.test(line)));
    lines.length = 0;
    assert.equal(await runHealthComponentsCommand({}), 0);
    assert.ok(lines.some((line) => /fixture.*open/.test(line)));
    assert.ok(!lines.some((line) => line.includes("unknown")));
  } finally {
    console.log = originalLog;
    arrayOnly = false;
  }
});

test.after(async () => {
  delete process.env.OMNIROUTE_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("GH #6677: omniroute health should succeed against a server that only implements /api/monitoring/health", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = () => {};

  let exitCode: number;
  try {
    exitCode = await runHealthCommand({});
  } finally {
    console.error = originalError;
    console.log = originalLog;
    arrayOnly = false;
  }

  assert.equal(
    exitCode,
    0,
    `runHealthCommand() should return 0 against a live server that implements ` +
      `/api/monitoring/health, but got exit code ${exitCode}. Captured stderr: ${errors.join(" | ")}`
  );
});
