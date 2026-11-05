import { describe, it, expect, vi } from "vitest";
import { normalizeUri } from "@/commands/thread";

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
