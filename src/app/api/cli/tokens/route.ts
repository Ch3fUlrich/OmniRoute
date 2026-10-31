import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { resolveOperatorCredential } from "@/lib/api/operatorCredential";
import { createAccessToken, listAccessTokens } from "@/lib/db/accessTokens";
import { TOKEN_SCOPES, isLimitedScope, type TokenScope } from "@/lib/accessTokens/scopes";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/**
 * /api/cli/tokens — manage scoped CLI access tokens. Admin-only: the path is in
 * ADMIN_SCOPE_PREFIXES, so the central pipeline + requireManagementAuth both
 * require an `admin` credential (a read/write token gets 403 before here).
 *
 * Minting never hands out more privilege than the caller holds: an `admin` token is
 * operator-only (dashboard session or local CLI). Machine credentials — manage/admin-scoped
 * API keys and `oma_` access tokens — top out at `write`, so a key given to automation cannot
 * turn itself into an admin token that outlives it. Every token passes the always-protected
 * tier, so minting stays authenticated with login disabled, too.
 */

/** Scopes a non-operator (API key / `oma_` token) caller may mint. */
const MACHINE_CREDENTIAL_MINT_ALLOWLIST: readonly string[] = ["read", "write"];

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json({ tokens: listAccessTokens() });
}

const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    scope: z.enum(TOKEN_SCOPES).optional(),
    expiresInDays: z.number().int().positive().max(3650).optional(),
    expiresInMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((data) => !(data.expiresInDays !== undefined && data.expiresInMinutes !== undefined), {
    message: "Cannot specify both expiresInDays and expiresInMinutes",
    path: ["expiresInMinutes"],
  })
  .refine((data) => !(isLimitedScope(data.scope) && typeof data.expiresInMinutes !== "number"), {
    message:
      "Scope 'logs:read' requires expiresInMinutes (limited tokens cannot be non-expiring or day-based)",
    path: ["expiresInMinutes"],
  });

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(createSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { name, scope, expiresInDays, expiresInMinutes } = validation.data;
  const requestedScope: TokenScope = scope ?? "read";

  if (!MACHINE_CREDENTIAL_MINT_ALLOWLIST.includes(requestedScope)) {
    let operator: Awaited<ReturnType<typeof resolveOperatorCredential>>;
    try {
      operator = await resolveOperatorCredential(request, { alwaysRequireAuth: true });
    } catch {
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    }
    if (!operator) {
      return createErrorResponse({
        status: 403,
        message:
          "Admin-scoped access tokens can only be created from the dashboard or the local CLI.",
        type: "invalid_request",
      });
    }
  }

  const expiresAt =
    typeof expiresInMinutes === "number"
      ? new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
      : typeof expiresInDays === "number"
        ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
        : null;

  const { record, secret } = createAccessToken({ name, scope: requestedScope, expiresAt });

  // `token` (the plaintext secret) is returned ONCE here and never again.
  return NextResponse.json({
    success: true,
    token: secret,
    id: record.id,
    name: record.name,
    scope: record.scope,
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}
