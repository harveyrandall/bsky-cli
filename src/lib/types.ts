export interface Config {
  bgs: string;
  host: string;
  handle: string;
  password: string;
}

export interface AuthInfo {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
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
