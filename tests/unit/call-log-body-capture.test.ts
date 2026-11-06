import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const dataDir = fs.mkdtempSync("/tmp/opencode/call-log-body-capture-");
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
const originalGate = process.env.CALL_LOG_CAPTURE_BODIES;
const core = await import("../../src/lib/db/core.ts");
const { saveCallLog, getCallLogs, getCallLogById } =
  await import("../../src/lib/usage/callLogs.ts");

test.after(() => {
  core.resetDbInstance();
  if (originalGate === undefined) delete process.env.CALL_LOG_CAPTURE_BODIES;
  else process.env.CALL_LOG_CAPTURE_BODIES = originalGate;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const entry = {
  model: "gpt-4.1",
  requestedModel: "requested-model",
  provider: "openai",
  status: 200,
  sessionTag: "plangraph-job-x",
  duration: 42,
  tokens: { prompt_tokens: 11, completion_tokens: 7 },
  requestBody: { messages: [{ role: "user", content: "hello" }] },
  responseBody: { choices: [{ message: { content: "world" } }] },
  pipelinePayloads: { providerRequest: { body: { message: "hello" } } },
};

test("gate off preserves metadata and the plangraph witness contract without artifacts", async () => {
  process.env.CALL_LOG_CAPTURE_BODIES = "false";
  await saveCallLog({ ...entry, id: "gate-off" });
  const row = core
    .getDbInstance()
    .prepare("SELECT * FROM call_logs WHERE id = ?")
    .get("gate-off") as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    model: entry.model,
    requested_model: entry.requestedModel,
    provider: entry.provider,
    status: 200,
    session_tag: entry.sessionTag,
    duration: 42,
    tokens_in: 11,
    tokens_out: 7,
    error_summary: null,
    detail_state: "none",
    has_request_body: 0,
    has_response_body: 0,
    has_pipeline_details: 0,
    artifact_relpath: null,
    request_summary: null,
    has_content: 1,
  }))
    assert.equal(row[key], value, key);
  assert.ok(row.usage_provenance);
  assert.equal(fs.existsSync(path.join(dataDir, "call_logs")), false);

  // GET /api/usage/call-logs uses getCallLogs. plangraph's
  // src/plangraph/spawner/gateway_witness.py:51-65 served_models() reads
  // exactly sessionTag, status, model and provider from these returned rows.
  const rows = await getCallLogs({ sessionTag: entry.sessionTag });
  assert.equal(rows.length, 1);
  for (const key of ["sessionTag", "status", "model", "provider"] as const)
    assert.equal(rows[0][key], entry[key]);
  assert.equal((await getCallLogs({ sessionTag: "other-job" })).length, 0);
});

test("gate off retains error classification without writing an error-only artifact", async () => {
  process.env.CALL_LOG_CAPTURE_BODIES = "false";
  await saveCallLog({ id: "error-only", status: 504, error: "upstream timeout" });
  const row = core
    .getDbInstance()
    .prepare("SELECT * FROM call_logs WHERE id = ?")
    .get("error-only") as Record<string, unknown>;
  assert.equal(row.error_summary, "upstream timeout");
  assert.ok(row.error_type);
  assert.equal(row.detail_state, "none");
  assert.equal(row.artifact_relpath, null);
  assert.equal(fs.existsSync(path.join(dataDir, "call_logs")), false);
});

test("unset and true write artifacts, and switching off leaves existing details readable", async () => {
  for (const gate of [undefined, "true"]) {
    if (gate === undefined) delete process.env.CALL_LOG_CAPTURE_BODIES;
    else process.env.CALL_LOG_CAPTURE_BODIES = gate;
    const id = `enabled-${gate}`;
    await saveCallLog({ ...entry, id });
    const detail = await getCallLogById(id);
    assert.equal(detail?.detailState, "ready");
    const artifact = path.join(dataDir, "call_logs", detail!.artifactRelPath!);
    assert.ok(fs.existsSync(artifact));
    const bytes = fs.readFileSync(artifact);
    process.env.CALL_LOG_CAPTURE_BODIES = "false";
    assert.deepEqual((await getCallLogById(id))?.responseBody, entry.responseBody);
    assert.deepEqual(fs.readFileSync(artifact), bytes);
  }
});
