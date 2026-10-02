/** Public callback route prefix for async jobs (see src/app/api/async-callbacks/[jobId]/route.ts). */
export const ASYNC_CALLBACK_PATH_PREFIX = "/api/async-callbacks/";

/** Header that carries the per-job callback token. */
export const ASYNC_CALLBACK_TOKEN_HEADER = "X-Callback-Token";
