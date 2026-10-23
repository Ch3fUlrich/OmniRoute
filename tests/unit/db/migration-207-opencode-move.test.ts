import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep all fixture writes inside the assigned checkout, including on Windows.
const cacheDir = path.join(process.cwd(), "node_modules/.cache");
fs.mkdirSync(cacheDir, { recursive: true });
const fixture = fs.mkdtempSync(path.join(cacheDir, "migration-207-move-"));
const migrationsDir = path.join(fixture, "migrations");
const repoMigrations = fileURLToPath(new URL("../../../src/lib/db/migrations/", import.meta.url));
const targetMigration = "207_remove_opencode_free_provider.sql";
fs.mkdirSync(migrationsDir);
for (const name of fs
  .readdirSync(repoMigrations)
  .filter((name) => /^\d+_.+\.sql$/.test(name) && Number.parseInt(name, 10) < 207)) {
  fs.copyFileSync(path.join(repoMigrations, name), path.join(migrationsDir, name));
}
process.env.DATA_DIR = path.join(fixture, "data");
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const { runMigrations } = await import("../../../src/lib/db/migrationRunner.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("migration 207 moves keyed legacy connections to Zen without changing ids or credentials", () => {
  const db = core.getDbInstance();
  assert.equal(
    db.prepare("SELECT version FROM _omniroute_migrations WHERE version = '207'").get(),
    undefined
  );
  const insert = db.prepare(
    "INSERT INTO provider_connections " +
      "(id, provider, auth_type, name, api_key, access_token, refresh_token, id_token, " +
      "provider_specific_data, created_at, updated_at) " +
      "VALUES (?, ?, 'apikey', ?, ?, ?, NULL, NULL, NULL, '2026-10-01', '2026-10-01')"
  );
  // Deliberately inert credential markers, not usable keys or token-shaped strings.
  insert.run("legacy-api", "opencode", "API fixture", "fixture credential A", null);
  insert.run("legacy-access", "oc", "Access fixture", null, "fixture credential B");
  insert.run("legacy-keyless", "opencode", "Keyless fixture", null, null);
  insert.run("zen-control", "opencode-zen", "Zen fixture", "fixture credential C", null);
  const read = (id: string) =>
    db.prepare("SELECT * FROM provider_connections WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
  const originals = [read("legacy-api"), read("legacy-access")];
  const control = read("zen-control");
  assert.ok(control);
  for (const row of originals) assert.ok(row);

  fs.copyFileSync(
    path.join(repoMigrations, targetMigration),
    path.join(migrationsDir, targetMigration)
  );
  assert.equal(runMigrations(db, { isNewDb: false }), 1);
  assert.ok(db.prepare("SELECT version FROM _omniroute_migrations WHERE version = '207'").get());
  for (const original of originals) {
    const migrated = read(String(original.id));
    assert.ok(migrated, "the same connection id must survive");
    assert.deepEqual(
      { ...migrated, updated_at: original.updated_at },
      { ...original, provider: "opencode-zen" },
      "only the provider and update timestamp may change; all credential columns stay intact"
    );
  }
  assert.equal(read("legacy-keyless"), undefined);
  assert.deepEqual(read("zen-control"), control);
  assert.equal(runMigrations(db, { isNewDb: false }), 0);
});
