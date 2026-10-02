/**
 * API: Async jobs
 * POST — create a job for work handed to an external system. The response carries the callback
 *        path, the header name and the per-job token the external system must present; the
 *        token is shown ONCE (only its hash is stored).
 *
 * The external system answers on the public, token-gated route /api/async-callbacks/{jobId};
 * the creator polls GET /api/async-jobs/{jobId}.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { createAsyncJob } from "@/lib/db/asyncJobs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import {
  ASYNC_CALLBACK_PATH_PREFIX,
  ASYNC_CALLBACK_TOKEN_HEADER,
} from "@/shared/constants/asyncJobs";

const METADATA_MAX_CHARS = 4096;

const createAsyncJobSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= METADATA_MAX_CHARS, {
        message: `metadata exceeds ${METADATA_MAX_CHARS} characters`,
      })
      .optional(),
    ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(buildErrorBody(400, "Invalid JSON body"), { status: 400 });
  }
  const validation = validateBody(createAsyncJobSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json(buildErrorBody(400, "Invalid request"), { status: 400 });
  }

  try {
    const { job, callbackToken, reused } = createAsyncJob(validation.data);
    if (reused || !callbackToken) {
      // The token of an existing job is never shown again; its creator already holds it.
      return NextResponse.json({ job, reused: true });
    }
    return NextResponse.json(
      {
        job,
        reused: false,
        callback: {
          path: `${ASYNC_CALLBACK_PATH_PREFIX}${job.id}`,
          header: ASYNC_CALLBACK_TOKEN_HEADER,
          token: callbackToken,
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(buildErrorBody(500, sanitizeErrorMessage(error)), { status: 500 });
  }
}
