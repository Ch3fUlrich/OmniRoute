/**
 * API: Async job by id
 * GET — poll a job: status, result, error and the three timestamps. The callback token is never
 *       returned. A job past its expiry reads as `expired`.
 */

import { NextResponse } from "next/server";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getAsyncJob } from "@/lib/db/asyncJobs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { jobId } = await params;
    const job = getAsyncJob(jobId);
    if (!job) {
      return NextResponse.json(buildErrorBody(404, "Async job not found"), { status: 404 });
    }
    return NextResponse.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(buildErrorBody(500, sanitizeErrorMessage(error)), { status: 500 });
  }
}
