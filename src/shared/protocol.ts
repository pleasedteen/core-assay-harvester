/** Wire-level constants shared by the mock site and the collector. */

import { createHash } from "node:crypto";

export const SESSION_HEADER = "x-site-session";
export const SIGNATURE_HEADER = "x-site-signature";
export const NONCE_HEADER = "x-site-nonce";
export const ALGORITHM_HEADER = "x-site-alg";
export const RETRY_AFTER_MS_HEADER = "x-retry-after-ms";
export const SNAPSHOT_HEADER = "x-snapshot-id";

export const SIGNATURE_ALGORITHM = "sha256(sessionId\\nnonce\\nmethod\\ntarget)";

/**
 * The challenge response required for every request after the directory
 * bootstrap. `nonce` is supplied by the previous successful site response and
 * is rotated after each accepted request, so a captured signature cannot be
 * replayed and requests cannot be reordered.
 */
export function computeSignature(
  sessionId: string,
  nonce: string,
  method: string,
  target: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}\n${nonce}\n${method.toUpperCase()}\n${target}`)
    .digest("hex");
}
