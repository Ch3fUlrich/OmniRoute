import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { scopeSatisfies } from "../../src/lib/accessTokens/scopes.ts";
import { registerResilience } from "../../bin/cli/commands/resilience.mjs";

test("read token route table preserves status and CLI reads and denies writes", () => {
  for (const path of [
    "/api/providers",
    "/api/providers/client",
    "/api/providers/expiration",
    "/api/providers/id/models",
    "/api/resilience",
    "/api/resilience/model-cooldowns",
    "/api/monitoring/health",
    "/api/usage/quota",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(
        scopeSatisfies("read", inferRequiredScope(method, path)),
        true,
        `${method} ${path}`
      );
    }
  }
  for (const [method, path] of [
    ["POST", "/api/providers"],
    ["POST", "/api/resilience/reset"],
    ["GET", "/api/cli/tokens"],
    ["GET", "/api/providers/id"],
    ["HEAD", "/api/providers/id/"],
  ]) {
    assert.equal(scopeSatisfies("read", inferRequiredScope(method, path)) ? 200 : 403, 403);
  }
});

test("resilience lockouts calls model-cooldowns successfully with a read token", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "r8-read-fixture";
  let called = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer r8-read-fixture");
    assert.equal(path, "/api/resilience/model-cooldowns");
    called = true;
    return Response.json(
      { items: [] },
      { status: scopeSatisfies("read", inferRequiredScope("GET", path)) ? 200 : 403 }
    );
  };
  console.log = () => {};
  try {
    const program = new Command();
    registerResilience(program);
    await program.parseAsync(["resilience", "lockouts"], { from: "user" });
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = oldKey;
  }
});
