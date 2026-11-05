import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { register_providers } from "../../bin/cli/api-commands/providers.mjs";
import { runProvidersStatusCommand } from "../../bin/cli/commands/providers.mjs";
import {
  runProviderEditCommand,
  runProviderRemoveCommand,
} from "../../bin/cli/commands/provider-crud.mjs";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { registerResilience } from "../../bin/cli/commands/resilience.mjs";

test("r9 CLI read and read-back contracts are isolated from operator credentials", async () => {
  const saved = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), "r9-cli-"));
  Object.assign(process.env, {
    HOME: home,
    DATA_DIR: home,
    OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED: "1",
    OMNIROUTE_CLI_TOKEN: "fixture",
    OMNIROUTE_BASE_URL: "https://fixture.invalid",
    OMNIROUTE_API_KEY: "fixture-read",
  });
  const original = {
    fetch: globalThis.fetch,
    log: console.log,
    error: console.error,
    write: process.stderr.write,
    exitCode: process.exitCode,
  };
  let warnings = "";
  process.stderr.write = ((chunk: string) => {
    warnings += chunk;
    return true;
  }) as typeof process.stderr.write;
  const lines: string[] = [];
  console.log = console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    for (const expiration of [200, 401, 403, 404, 405, 501, 500, "network", "malformed"] as const) {
      lines.length = 0;
      warnings = "";
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/providers/expiration") {
          if (expiration === "network") throw new Error("offline");
          if (expiration === "malformed") return new Response("invalid");
          return Response.json({ list: [] }, { status: expiration });
        }
        return Response.json({
          connections: [{ id: "id", provider: "fixture", name: "inventory" }],
        });
      };
      assert.equal(
        await runProvidersStatusCommand({ json: true }),
        [401, 403].includes(Number(expiration)) ? 1 : 0
      );
      if ([401, 403].includes(Number(expiration)))
        assert.match(lines.join(" "), /needs admin scope/);
      else {
        assert.match(lines.join(" "), /inventory/);
        assert.ok(JSON.parse(lines.join("\n")));
        assert.equal(/expiration metadata unavailable/.test(warnings), expiration !== 200);
      }
    }
    for (const [command, path, args, status] of [
      ["get-api-providers", "/api/providers", [], 200],
      ["get-api-providers-client", "/api/providers/client", [], 200],
      ["get-api-providers-id-models", "/api/providers/id/models", ["--id", "id"], 200],
      ["get-api-providers-id-", "/api/providers/id", ["--id", "id"], 403],
      ["get-api-providers", "/api/providers", [], 403],
      ["get-api-providers", "/api/providers", [], 500],
      ["patch-api-providers-id-", "/api/providers/id", ["--id", "id", "--body", "{}"], 403],
    ] as const) {
      let called = false;
      globalThis.fetch = async (input, init) => {
        assert.equal(new URL(String(input)).pathname, path);
        assert.equal(init?.method, command.startsWith("patch-") ? "PATCH" : "GET");
        assert.equal(
          new Headers(init?.headers).get("authorization") === "Bearer explicit-fixture",
          true
        );
        called = true;
        return Response.json({}, { status });
      };
      const program = new Command()
        .option("--api-key <key>")
        .option("--base-url <url>")
        .option("--json");
      register_providers(program);
      process.exitCode = 0;
      await program.parseAsync(
        [
          "--api-key",
          "explicit-fixture",
          "--base-url",
          "https://fixture.invalid",
          "--json",
          "providers",
          command,
          ...args,
        ],
        { from: "user" }
      );
      assert.equal(called, true);
      assert.equal(process.exitCode, status === 200 ? 0 : 1);
    }
    process.exitCode = 0;
    for (const args of [
      ["status"],
      ["breakers"],
      ["cooldowns"],
      ["lockouts"],
      ["reset", "--provider", "fixture", "--yes"],
      ["profile", "show"],
      ["config", "show"],
      ["config", "set", "--threshold", "3"],
    ]) {
      let called = false;
      globalThis.fetch = async (input, init) => {
        assert.equal(new URL(String(input)).origin, "https://explicit.invalid");
        assert.equal(
          new Headers(init?.headers).get("authorization") === "Bearer explicit-fixture",
          true
        );
        called = true;
        return Response.json({ items: [] });
      };
      const program = new Command()
        .option("--api-key <key>")
        .option("--base-url <url>")
        .option("--json");
      registerResilience(program);
      await program.parseAsync(
        [
          "--api-key",
          "explicit-fixture",
          "--base-url",
          "https://explicit.invalid",
          "--json",
          "resilience",
          ...args,
        ],
        { from: "user" }
      );
      assert.equal(called, true);
    }
    for (const status of [401, 403]) {
      for (const run of [runProviderEditCommand, runProviderRemoveCommand]) {
        lines.length = 0;
        globalThis.fetch = async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/providers")
            return Response.json({ connections: [{ id: "id", provider: "fixture" }] });
          return Response.json({}, { status: init?.method === "GET" ? status : 200 });
        };
        assert.equal(
          await run("id", {
            name: "renamed",
            yes: true,
            apiKey: "explicit-fixture",
            baseUrl: "https://fixture.invalid",
          }),
          1
        );
        assert.match(lines.join(" "), /read-back failed: needs admin scope/);
      }
    }
  } finally {
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
    process.stderr.write = original.write;
    process.exitCode = original.exitCode;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider detail variants never widen read; static siblings remain readable", () => {
  for (const path of [
    "/api/providers//id",
    "/api/providers/id//",
    "/API/PROVIDERS/ID",
    "/api/providers/status",
    "/API/CLI/TOKENS",
    "//api/keys/x/reveal",
    "/api/providers/CLIENT",
    "/api/providers/Client",
    "/api/providers/EXPIRATION",
    "/api/providers//client",
  ]) {
    for (const method of ["GET", "HEAD", "PATCH", "PUT"])
      assert.equal(inferRequiredScope(method, path), "admin");
  }
  for (const name of [
    "client",
    "expiration",
    "quota-windows",
    "codex-cooldown",
    "health-autopilot",
    "free-onboarding",
    "deprecated",
    "bulk-web-session",
    "openrouter-stats",
    "health-matrix",
    "bulk",
    "validate",
    "import",
    "web-session-contract",
    "test-batch",
  ]) {
    for (const method of ["GET", "HEAD"])
      assert.equal(inferRequiredScope(method, `/api/providers/${name}`), "read");
  }
});
