import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RENAMED_MIGRATION_COMPATIBILITY } from "../../src/lib/db/migrationRunner/constants.ts";

test("fork benchmark migration moves off upstream's occupied 213 slot", () => {
  assert.ok(
    RENAMED_MIGRATION_COMPATIBILITY.some(
      (entry) =>
        entry.fromVersion === "213" &&
        entry.fromName === "model_benchmarks" &&
        entry.toVersion === "228" &&
        entry.toName === "model_benchmarks"
    )
  );
  assert.ok(fs.existsSync("src/lib/db/migrations/213_api_key_preferred_connections.sql"));
  assert.ok(fs.existsSync("src/lib/db/migrations/228_model_benchmarks.sql"));
  assert.equal(fs.existsSync("src/lib/db/migrations/213_model_benchmarks.sql"), false);
});
