import { AtUri as ParsedAtUri, isValidDid, isValidHandle, isValidTid } from "@atproto/syntax";

// Template-literal and branded types give stored strings a checked shape.
// Neither exists at runtime, so every value from outside (config, user input,
// API responses) goes through a guard; `as` casts appear only in the guards.

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

export function isAtUri(v: unknown): v is AtUri {
  if (!isString(v)) return false;
  try {
    const parsed = new ParsedAtUri(v);
    return isDid(parsed.host) && parsed.collection === "app.bsky.feed.post" && isRkey(parsed.rkey);
  } catch {
    return false;
  }
}

export const rkeyOf = (uri: AtUri): Rkey => uri.slice(uri.lastIndexOf("/") + 1) as Rkey;

/** createPost's `{ uri, cid }` as a checked StrongRef. */
export function toStrongRef(res: { uri: string; cid: string }): StrongRef {
  if (!isAtUri(res.uri) || !isCid(res.cid)) {
    throw new Error(`Unexpected post reference from the server: ${JSON.stringify(res)}`);
  }
  return { uri: res.uri, cid: res.cid };
}
