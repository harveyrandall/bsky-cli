import { isDatetimeString, isValidDid, isValidHandle, isValidTid } from "@atproto/syntax";

// Template-literal and branded types give stored strings a checked shape.
// Neither exists at runtime, so every value from outside (config, user input,
// API responses) goes through a guard. The remaining `as` casts only brand
// strings the code has just built from checked parts.

export type Did = `did:plc:${string}` | `did:web:${string}`;
export type Handle = `${string}.${string}`;
export type AtUri = `at://${Did}/app.bsky.feed.post/${string}`;
/** CIDv1, base32 multibase prefix. */
export type Cid = `b${string}`;
/** A TID. */
export type Rkey = string & { readonly __brand: "Rkey" };
/** "A" … "ZZZ". */
export type ThreadLetter = Uppercase<string>;
type Upper = Uppercase<string>;
// Adjacent placeholders each match one character except the last, so
// `${Upper}${number}` alone would reject "AA3".
export type OwnLabel =
  | `${number}`
  | `${Upper}${number}`
  | `${Upper}${Upper}${number}`
  | `${Upper}${Upper}${Upper}${number}`;
export type Cooldown = 0 | 5 | 10 | 15;
export type IsoUtc = `${number}-${number}-${number}T${number}:${number}:${number}${"" | `.${number}`}Z`;
/** 6 base32 characters. */
export type SessionId = string & { readonly __brand: "SessionId" };

export interface StrongRef {
  uri: AtUri;
  cid: Cid;
}

const isString = (v: unknown): v is string => typeof v === "string";

export const isDid = (v: unknown): v is Did => isString(v) && /^did:(plc|web):/.test(v) && isValidDid(v);
export const isHandle = (v: unknown): v is Handle => isString(v) && isValidHandle(v);
export const isRkey = (v: unknown): v is Rkey => isString(v) && isValidTid(v);
export const isCid = (v: unknown): v is Cid => isString(v) && /^b[a-z2-7]+$/.test(v);
export const isOwnLabel = (v: unknown): v is OwnLabel => isString(v) && /^(\d+|[A-Z]{1,3}\d+)$/.test(v);
export const isCooldown = (v: unknown): v is Cooldown => v === 0 || v === 5 || v === 10 || v === 15;
export const isIsoUtc = (v: unknown): v is IsoUtc => isString(v) && v.endsWith("Z") && isDatetimeString(v);
export const isSessionId = (v: unknown): v is SessionId => isString(v) && /^[a-z2-7]{6}$/.test(v);
export const isMarker = (v: unknown): v is string => isString(v) && /^\S+$/.test(v);

// The whole string, canonical form only (no query, fragment or extra
// segments), so what the guard checks is exactly what callers use.
const POST_URI = /^at:\/\/([^/?#]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;

export function isAtUri(v: unknown): v is AtUri {
  const match = isString(v) ? POST_URI.exec(v) : null;
  return match !== null && isDid(match[1]) && isRkey(match[2]);
}

export const rkeyOf = (uri: AtUri): Rkey => POST_URI.exec(uri)![2] as Rkey;

/** createPost's `{ uri, cid }` as a checked StrongRef. */
export function toStrongRef(res: { uri: string; cid: string }): StrongRef {
  if (!isAtUri(res.uri) || !isCid(res.cid)) {
    throw new Error(`Unexpected post reference from the server: ${JSON.stringify(res)}`);
  }
  return { uri: res.uri, cid: res.cid };
}
