import { describe, it, expect, afterEach } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import { AtpAgent } from "@atproto/api";
import { isNetworkError } from "@/lib/errors";

const failure = (message: string, o: { code?: string; cause?: unknown } = {}) => Object.assign(new TypeError(message, { cause: o.cause }), o.code ? { code: o.code } : {});
const xrpc = (cause: Error, status = 1) => Object.assign(new Error(cause.message, { cause }), { status });

describe("isNetworkError", () => {
  // Each of these is what the runtime really produced against a loopback server.
  describe("through the API client", () => {
    it.each([
      ["Node, refused", failure("fetch failed", { cause: failure("connect ECONNREFUSED 127.0.0.1:49152", { code: "ECONNREFUSED" }) })],
      ["Node, reset", failure("fetch failed", { cause: failure("read ECONNRESET", { code: "ECONNRESET" }) })],
      ["Node, cut off mid-response", failure("terminated", { cause: failure("other side closed", { code: "UND_ERR_SOCKET" }) })],
      ["Bun, refused", failure("Unable to connect. Is the computer able to access the url?", { code: "ConnectionRefused" })],
      ["Bun, reset", failure("The socket connection was closed unexpectedly.", { code: "ECONNRESET" })],
    ])("%s", (_, cause) => {
      expect(isNetworkError(xrpc(cause))).toBe(true);
    });
  });
  describe("from a plain fetch", () => {
    it.each([
      ["Node, refused", failure("fetch failed", { cause: failure("connect ECONNREFUSED 127.0.0.1:49152", { code: "ECONNREFUSED" }) })],
      ["Node, cut off", failure("terminated", { cause: failure("other side closed", { code: "UND_ERR_SOCKET" }) })],
      ["Bun, refused", failure("Unable to connect.", { code: "ConnectionRefused" })],
      ["Bun, closed", failure("The socket connection was closed unexpectedly.", { code: "ECONNRESET" })],
      ["Bun, no socket", failure("Was there a typo in the url or port?", { code: "FailedToOpenSocket" })],
      ["a DNS failure", failure("getaddrinfo ENOTFOUND bsky.social", { code: "ENOTFOUND" })],
      ["a DNS failure for now", failure("getaddrinfo EAI_AGAIN bsky.social", { code: "EAI_AGAIN" })],
      ["a timeout", failure("connect ETIMEDOUT", { code: "ETIMEDOUT" })],
    ])("%s", (_, err) => {
      expect(isNetworkError(err)).toBe(true);
    });
  });
  describe("for real, against a server on this machine", () => {
    let server: Server;
    const listening = async (connected: Parameters<typeof createServer>[1]) => {
      server = createServer(connected as never).listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const failed = (service: string) => new AtpAgent({ service }).com.atproto.server.describeServer().catch((err: unknown) => err);
    afterEach(() => void server?.close());

    it("sees a connection dropped straight away", async () => {
      const url = await listening((socket) => socket.destroy());
      expect(isNetworkError(await failed(url))).toBe(true);
      expect(isNetworkError(await fetch(url).catch((err: unknown) => err))).toBe(true);
    });
    it("sees a response cut off halfway", async () => {
      const url = await listening((socket) => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{");
        setTimeout(() => socket.destroy(), 20);
      });
      expect(isNetworkError(await failed(url))).toBe(true);
    });
  });
  it("goes by the words too, for errors with no code", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("x", { cause: new Error("connect ECONNREFUSED") }))).toBe(true);
  });
  describe("anything the server answered", () => {
    it.each([[400], [401], [404], [429], [500], [502]])("isn't one, at %i", (status) => {
      expect(isNetworkError(xrpc(new Error("no"), status))).toBe(false);
    });
    it("isn't one if the response couldn't be read", () => {
      expect(isNetworkError(xrpc(new Error("The server gave an invalid response"), 2))).toBe(false);
    });
  });
  it.each([[new Error("Record too large")], ["a string"], [undefined], [null]])("isn't %s", (err) => {
    expect(isNetworkError(err)).toBe(false);
  });
  it("copes with a cause that points at itself", () => {
    const err = new Error("no") as Error & { cause: unknown };
    err.cause = err;
    expect(isNetworkError(err)).toBe(false);
  });
});
