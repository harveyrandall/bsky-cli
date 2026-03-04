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
