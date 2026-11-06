/** `status` on an API client error that threw without an HTTP status, which can be after a response began. */
const NO_RESPONSE = 1;

/** Each runtime words these its own way. A safety net: everything today goes through the API client. */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

const TRANSPORT_WORDS = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/;

/** True for transport failures (offline, DNS, refused, cut off, timed out); the request may or may not have arrived. */
export function isNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if ((e as { status?: unknown }).status === NO_RESPONSE) return true;
    if (TRANSPORT_WORDS.test(e.message) || TRANSPORT_CODES.has((e as NodeJS.ErrnoException).code ?? "")) return true;
  }
  return false;
}
