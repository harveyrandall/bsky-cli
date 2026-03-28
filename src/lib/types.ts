/** @deprecated Use SessionConfig — password must never be persisted */
export interface Config {
  bgs: string;
  host: string;
  handle: string;
  password: string;
}

/**
 * Persisted session — contains only JWT tokens, never passwords.
 * Stored with 0o600 permissions in platform-appropriate config dir.
 */
export interface SessionConfig {
  host: string;
  bgs: string;
  handle: string;
  did: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface AuthInfo {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface ThreadDraftPost {
  text: string;
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  link?: string;
}

export interface Draft {
  id: string;
  createdAt: string;
  reason: "manual" | "length" | "network";
  type: "post" | "reply" | "quote" | "thread";
  text: string;
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  replyUri?: string;
  quoteUri?: string;
  posts?: ThreadDraftPost[];
}

/**
 * A post scheduled for future publication.
 * Stored as JSON in the `scheduled/` directory alongside drafts.
 * `scheduledAt` is always ISO 8601 UTC; displayed in local time.
 */
export interface ScheduledPost {
  id: string;
  createdAt: string;       // ISO 8601 UTC — when the entry was created
  scheduledAt: string;     // ISO 8601 UTC — when the post should go live
  text: string;
  images?: string[];
  imageAlts?: string[];
  video?: string;
  videoAlt?: string;
  rrule?: string;          // RFC 5545 RRULE e.g. "FREQ=DAILY;COUNT=5" or "FREQ=DAILY" (infinite)
  remainingCount?: number; // decremented each time post is published; undefined = infinite
}

export interface GlobalOptions {
  json?: boolean;
  profile?: string;
  verbose?: boolean;
}

// Jetstream WebSocket event types
// See: https://github.com/bluesky-social/jetstream

export interface JetstreamCommitEvent {
  did: string;
  time_us: number;
  kind: "commit";
  commit: {
    rev: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    record?: {
      $type?: string;
      text?: string;
      createdAt?: string;
      langs?: string[];
      reply?: {
        root: { uri: string; cid: string };
        parent: { uri: string; cid: string };
      };
      [key: string]: unknown;
    };
    cid?: string;
  };
}

export interface JetstreamIdentityEvent {
  did: string;
  time_us: number;
  kind: "identity";
  identity: {
    did: string;
    handle: string;
    seq: number;
    time: string;
  };
}

export interface JetstreamAccountEvent {
  did: string;
  time_us: number;
  kind: "account";
  account: {
    active: boolean;
    did: string;
    seq: number;
    time: string;
    status?: string;
  };
}

export type JetstreamEvent =
  | JetstreamCommitEvent
  | JetstreamIdentityEvent
  | JetstreamAccountEvent;
