import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isNativeBinaryCompatible } from "./native-binary-compat.mjs";
import { getBetterSqlitePrebuildTarget } from "./betterSqlitePrebuildTarget.mjs";
import { isTermux } from "./postinstallSupport.mjs";

export function ensureBetterSqliteBuildRelease({
  rootDir,
  compatible = isNativeBinaryCompatible,
  rebuild = (pkgDir) =>
    execFileSync(
      process.execPath,
      [
        createRequire(join(pkgDir, "package.json")).resolve("node-gyp/bin/node-gyp.js"),
        "rebuild",
        "--force_build=1",
      ],
      { cwd: pkgDir, stdio: "inherit" }
    ),
  warn = console.warn,
}) {
  const pkgDir = join(rootDir, "node_modules", "better-sqlite3");
  const target = join(pkgDir, "build", "Release", "better_sqlite3.node");
  if (!existsSync(pkgDir) || existsSync(target)) return;
  const prebuild = join(pkgDir, "prebuilds", `${getBetterSqlitePrebuildTarget()}.node`);
  if (!existsSync(prebuild)) return;
  if (
    !compatible(prebuild, {
      runtimePlatform: isTermux() ? "android" : process.platform,
      skipDlopen: false,
    })
  ) {
    warn("Skipping incompatible better-sqlite3 host prebuild; rebuilding from source.");
    try {
      rebuild(pkgDir);
    } catch (err) {
      warn(
        `Could not rebuild better-sqlite3; node-gyp and a working native toolchain are required: ${err.message}`
      );
    }
    return;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(prebuild, target);
    console.log(`  ✅ better-sqlite3 native binary materialised in build/Release (host prebuild).`);
  } catch (err) {
    console.warn(`  ⚠️  Could not materialise better-sqlite3 build/Release: ${err.message}`);
  }
}
