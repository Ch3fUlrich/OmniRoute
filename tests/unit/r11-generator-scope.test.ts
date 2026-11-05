import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

test("provider-only exit codes leave the 31 other tracked generated modules byte-identical", () => {
  const files = execFileSync("git", ["ls-files", "bin/cli/api-commands/*.mjs"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => !file.endsWith("/providers.mjs"));
  assert.equal(files.length, 31);
  for (const file of files) {
    const content = readFileSync(file);
    assert.deepEqual(content, execFileSync("git", ["show", `f9840b048c:${file}`]));
    assert.doesNotMatch(content.toString(), /if \(!res.ok\) process.exitCode = 1;/);
  }
  const dir = mkdtempSync(join(process.cwd(), "tests/unit/.r11-generator-"));
  try {
    const spec = join(dir, "fixture.json");
    writeFileSync(
      spec,
      JSON.stringify({
        paths: {
          "/api/providers": { get: { tags: ["Providers"], operationId: "listProviders" } },
          "/api/other": { get: { tags: ["Other"], operationId: "listOther" } },
        },
      })
    );
    execFileSync(process.execPath, ["scripts/cli/generate-api-commands.mjs"], {
      env: { ...process.env, OPENAPI_SPEC: spec, OPENAPI_OUT_DIR: dir },
    });
    assert.match(
      readFileSync(join(dir, "providers.mjs"), "utf8"),
      /if \(!res.ok\) process.exitCode = 1;/
    );
    assert.doesNotMatch(readFileSync(join(dir, "other.mjs"), "utf8"), /process.exitCode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
