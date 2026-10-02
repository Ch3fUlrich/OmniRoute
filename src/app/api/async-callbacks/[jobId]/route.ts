/**
 * Public callback for async jobs: the external system POSTs its progress or result here.
 *
 * There is no dashboard session and no API key on this route (it is public by prefix, see
 * PUBLIC_API_ROUTE_PREFIXES): the per-job token IS the authentication. Order of checks, cheapest
 * and most restrictive first, so an unauthenticated caller never makes the server read a body:
 *   1. token header present and valid for THIS job (unknown job and wrong token answer alike);
 *   2. per-job rate limit;
 *   3. declared size, then a streamed, capped read of the body;
 *   4. strict Zod validation;
 *   5. one atomic state transition (409 for a job that is no longer pending/running).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { applyAsyncJobCallback, verifyAsyncJobCallbackToken } from "@/lib/db/asyncJobs";
import { ASYNC_CALLBACK_TOKEN_HEADER } from "@/shared/constants/asyncJobs";
import {
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
} from "@/shared/middleware/bodySizeGuard";
import { checkRateLimit } from "@/shared/utils/rateLimiter";
import { logger } from "@/shared/utils/logger";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";

const CALLBACK_BODY_LIMIT_BYTES = 256 * 1024;
const PER_JOB_LIMIT = { limit: 30, window: 60 };
const FAILED_TOKEN_LIMIT = { limit: 120, window: 60 };

const callbackSchema = z
  .object({
    status: z.enum(["running", "progress", "completed", "failed"]),
    result: z.string().max(200_000).optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

function reply(status: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json(buildErrorBody(status, message), {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const token = request.headers.get(ASYNC_CALLBACK_TOKEN_HEADER) ?? "";

    if (!token || !verifyAsyncJobCallbackToken(jobId, token)) {
      // Wrong-token floods are bounded globally: the per-peer address behind a tunnel is one address.
      const flood = await checkRateLimit("async-callback:token-failures", [FAILED_TOKEN_LIMIT]);
      if (!flood.allowed) return reply(429, "Too many invalid callback attempts");
      return reply(401, "Invalid callback token");
    }

    const limited = await checkRateLimit(`async-callback:${jobId}`, [PER_JOB_LIMIT]);
    if (!limited.allowed) {
      const wait = Math.max(
        1,
        Math.ceil(((limited.resetAt ?? Date.now() + 60_000) - Date.now()) / 1000)
      );
      return reply(429, "Callback rate limit exceeded", { "Retry-After": String(wait) });
    }

    let rawBody: unknown;
    try {
      const bytes = await readRequestBodyWithLimit(request, CALLBACK_BODY_LIMIT_BYTES);
      rawBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      return cause instanceof RequestBodyTooLargeError
        ? reply(413, "Request body too large")
        : reply(400, "Invalid request body");
    }

    const validation = validateBody(callbackSchema, rawBody);
    if (isValidationFailure(validation)) return reply(400, "Invalid callback body");
    const { status, result, error } = validation.data;

    const outcome = applyAsyncJobCallback(jobId, {
      status: status === "progress" ? "running" : status,
      result,
      error,
    });
    if (outcome.ok === false) {
      if (outcome.reason === "terminal") {
        // Names only: the job id and its state. Never the token, the body or any header.
        logger.warn(`[async-jobs] late callback rejected: job=${jobId} status=${outcome.status}`);
        return reply(409, `job already in terminal state: ${outcome.status}`);
      }
      return reply(404, "Async job not found");
    }
    return NextResponse.json(
      { ok: true, status: outcome.job.status },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return reply(500, sanitizeErrorMessage(error));
  }
}
