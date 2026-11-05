import { isApiKeyRevealEnabled } from "@/lib/apiKeyExposure";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

/** Dashboard sessions represent the instance admin; no role claim is minted.
 * Never let a machine credential borrow a dashboard cookie's reveal privilege.
 */
export async function mayRevealProviderKeys(request: Request): Promise<boolean> {
  if (!isApiKeyRevealEnabled()) return false;
  if (["authorization", "x-api-key", "x-goog-api-key"].some((h) => request.headers.has(h)))
    return false;
  return isDashboardSessionAuthenticated(request);
}
