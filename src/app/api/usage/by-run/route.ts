import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCostBySessionTag } from "@/lib/db/costLedger";

/**
 * GET /api/usage/by-run?run_id=<id> — per-run cost rows, read from the
 * per-request ledger for every call tagged with `run_id`.
 *
 * `run_id` is the value the client sent as `x-omniroute-session-id`
 * (`call_logs.session_tag`) and is matched EXACTLY — no wildcard. Callers
 * following the `<lane>/<run-id>` convention can pass the bare lane string to
 * get the rows tagged with the lane itself.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const runId = (searchParams.get("run_id") || "").trim();
    if (!runId) {
      return NextResponse.json({ error: "run_id query param is required" }, { status: 400 });
    }

    const rows = getCostBySessionTag(runId);
    return NextResponse.json({ runId, rows });
  } catch (error) {
    console.error("[API] GET /api/usage/by-run error:", error);
    return NextResponse.json({ error: "Failed to fetch per-run costs" }, { status: 500 });
  }
}
