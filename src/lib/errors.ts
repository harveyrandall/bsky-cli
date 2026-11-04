/** True for errors where the request never reached Bluesky (offline, DNS, refused, timed out). */
export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  const cause = err instanceof Error ? err.cause : undefined;
  const causeMsg = cause instanceof Error ? cause.message : "";

  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    causeMsg.includes("fetch failed") ||
    causeMsg.includes("ECONNREFUSED") ||
    causeMsg.includes("ENOTFOUND")
  );
}
