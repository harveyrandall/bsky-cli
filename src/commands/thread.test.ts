import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { normalizeUri, registerThread } from "@/commands/thread";
import { getClient } from "@/index";
import { setPostLabeler } from "@/lib/format";

vi.mock("@/index", () => ({ getClient: vi.fn(), isJson: () => false }));

describe("normalizeUri", () => {
  it("leaves a full URI alone, whatever its DID method", () => {
    const uri = "at://did:web:example.test/app.bsky.feed.post/3lbx7kt5def2a";
    expect(normalizeUri(uri)).toBe(uri);
  });
  it("still completes a bare did:plc tail", () => {
    expect(normalizeUri("abc/app.bsky.feed.post/3lbx7kt5def2a")).toBe("at://did:plc:abc/app.bsky.feed.post/3lbx7kt5def2a");
  });
});

describe("bsky thread", () => {
  const post = (text: string) => ({ uri: "at://x", cid: "bafy", author: { handle: "alice.bsky.social" }, record: { text, createdAt: "2026-11-04T09:00:00.000Z" }, indexedAt: "2026-11-04T09:00:00.000Z" });
  it("labels what it prints, so /view #2 can be acted on", async () => {
    const getPostThread = vi.fn(async () => ({ data: { thread: { post: post("hi"), replies: [{ post: post("back") }] } } }));
    vi.mocked(getClient).mockResolvedValue({ getPostThread } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    setPostLabeler(() => "#2");
    const program = new Command();
    registerThread(program);
    await program.parseAsync(["thread", "at://did:plc:a/app.bsky.feed.post/3lbx7kt5def2a"], { from: "user" });
    const printed = [...log.mock.calls.flat(), ...write.mock.calls.map(([chunk]) => chunk)].join("");
    setPostLabeler();
    log.mockRestore();
    write.mockRestore();
    expect(printed.match(/#2/g)).toHaveLength(2);
  });
});
