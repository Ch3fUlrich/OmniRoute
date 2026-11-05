import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasStandaloneAppBundle, isTermux } from "../../scripts/build/postinstallSupport.mjs";

import { ensureBetterSqliteBuildRelease } from "../../scripts/build/ensureBetterSqliteBuildRelease.mjs";
import { getBetterSqlitePrebuildTarget } from "../../scripts/build/betterSqlitePrebuildTarget.mjs";

test("prebuild compatible copy, missing no-op, Termux mapping and default rebuild diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-prebuild-cases-"));
  const oldTermux = process.env.TERMUX_VERSION;
  try {
    const pkg = join(root, "node_modules", "better-sqlite3");
    const target = join(pkg, "build", "Release", "better_sqlite3.node");
    ensureBetterSqliteBuildRelease({ rootDir: root });
    mkdirSync(join(pkg, "prebuilds"), { recursive: true });
    ensureBetterSqliteBuildRelease({
      rootDir: root,
      compatible: () => assert.fail("missing prebuild"),
    });
    process.env.TERMUX_VERSION = "fixture";
    const prebuild = join(pkg, "prebuilds", `${getBetterSqlitePrebuildTarget()}.node`);
    writeFileSync(prebuild, "compatible fixture");
    ensureBetterSqliteBuildRelease({
      rootDir: root,
      compatible: (_path, options) => {
        assert.equal(options.runtimePlatform, "android");
        return true;
      },
    });
    assert.equal(readFileSync(target, "utf8"), "compatible fixture");
    rmSync(target);
    // Isolated package resolves this harmless stub instead of invoking a toolchain.
    const gyp = join(pkg, "node_modules", "node-gyp", "bin");
    mkdirSync(gyp, { recursive: true });
    writeFileSync(
      join(gyp, "node-gyp.js"),
      `require("node:fs").writeFileSync("rebuilt-marker", process.argv.slice(2).join(" "));`
    );
    ensureBetterSqliteBuildRelease({ rootDir: root, compatible: () => false, warn: () => {} });
    assert.equal(readFileSync(join(pkg, "rebuilt-marker"), "utf8"), "rebuild --force_build=1");
    const warnings: string[] = [];
    ensureBetterSqliteBuildRelease({
      rootDir: root,
      compatible: () => false,
      rebuild: () => {
        throw new Error("node-gyp unavailable");
      },
      warn: (message) => warnings.push(message),
    });
    assert.ok(warnings.some((message) => message.includes("node-gyp unavailable")));
    ensureBetterSqliteBuildRelease({
      rootDir: root,
      compatible: () => false,
      rebuild: () => {
        throw "non-Error failure";
      },
      warn: (message) => warnings.push(message),
    });
    assert.ok(warnings.some((message) => message.includes("non-Error failure")));
  } finally {
    if (oldTermux === undefined) delete process.env.TERMUX_VERSION;
    else process.env.TERMUX_VERSION = oldTermux;
    rmSync(root, { recursive: true, force: true });
  }
});

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
