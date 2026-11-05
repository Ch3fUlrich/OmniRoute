import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasStandaloneAppBundle, isTermux } from "../../scripts/build/postinstallSupport.mjs";

import { ensureBetterSqliteBuildRelease } from "../../scripts/build/ensureBetterSqliteBuildRelease.mjs";
import { getBetterSqlitePrebuildTarget } from "../../scripts/build/betterSqlitePrebuildTarget.mjs";

test("host SQLite prebuild compatibility is checked before materialising build/Release", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-prebuild-"));
  try {
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    const prebuild = join(pkgDir, "prebuilds", `${getBetterSqlitePrebuildTarget()}.node`);
    const target = join(pkgDir, "build", "Release", "better_sqlite3.node");
    mkdirSync(join(pkgDir, "prebuilds"), { recursive: true });
    writeFileSync(prebuild, "mock incompatible native addon");
    let rebuilt = 0;
    const warnings: string[] = [];
    ensureBetterSqliteBuildRelease({
      rootDir: root,
      compatible: (candidate, options) => {
        assert.equal(candidate, prebuild);
        assert.equal(options.skipDlopen, false);
        return false;
      },
      rebuild: (dir) => {
        assert.equal(dir, pkgDir);
        assert.equal(existsSync(target), false, "incompatible prebuild was not copied");
        rebuilt++;
        mkdirSync(join(pkgDir, "build", "Release"), { recursive: true });
        writeFileSync(target, "mock rebuilt native addon");
      },
      warn: (message) => warnings.push(message),
    });
    assert.equal(rebuilt, 1);
    assert.equal(existsSync(target), true);
    assert.ok(warnings.some((message) => message.includes("Skipping incompatible")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasStandaloneAppBundle returns false for source checkout without standalone app", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-postinstall-src-"));

  try {
    mkdirSync(join(root, "src", "app"), { recursive: true });
    assert.equal(hasStandaloneAppBundle(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("hasStandaloneAppBundle returns true for published standalone app bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-postinstall-standalone-"));

  try {
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "server.js"), "export {};\n");
    assert.equal(hasStandaloneAppBundle(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// isTermux detection
test("isTermux returns false when no termux signals present", () => {
  assert.equal(isTermux({}), false);
});

test("isTermux returns true when TERMUX_VERSION is set", () => {
  assert.equal(isTermux({ TERMUX_VERSION: "0.119" }), true);
});

test("isTermux returns true when PREFIX contains com.termux", () => {
  assert.equal(isTermux({ PREFIX: "/data/data/com.termux/files/usr" }), true);
});

test("isTermux returns false for non-termux PREFIX", () => {
  assert.equal(isTermux({ PREFIX: "/usr/local" }), false);
});
