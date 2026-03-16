import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => Buffer.from([0xa7, 0xf3])),
}));

vi.mock("@/config", () => ({
  bskyDir: vi.fn(() => "/mock/bsky-cli"),
}));

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { saveDraft, loadDraft, listDrafts, deleteDraft, resolveDraftId } from "./drafts";

const mockBase = "/mock/bsky-cli";
const defaultDraftsDir = join(mockBase, "drafts");

describe("saveDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates ID and writes JSON file", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1741392000000);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const draft = await saveDraft({
      type: "post",
      text: "Hello world",
      reason: "manual",
    });

    expect(draft.id).toBe("1741392000000-a7f3");
    expect(draft.text).toBe("Hello world");
    expect(draft.reason).toBe("manual");
    expect(draft.createdAt).toBeDefined();
    expect(mkdir).toHaveBeenCalledWith(defaultDraftsDir, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      join(defaultDraftsDir, "1741392000000-a7f3.json"),
      expect.stringContaining('"Hello world"'),
      { mode: 0o644 },
    );
  });

  it("uses profile-scoped directory when profile is provided", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1741392000000);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await saveDraft({ type: "post", text: "test", reason: "network" }, "work");

    expect(mkdir).toHaveBeenCalledWith(
      join(mockBase, "drafts-work"),
      { recursive: true },
    );
  });
});

describe("loadDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads and parses a draft file", async () => {
    const mockDraft = {
      id: "1741392000000-a7f3",
      createdAt: "2025-03-07T12:00:00.000Z",
      reason: "manual",
      type: "post",
      text: "Hello",
    };
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify(mockDraft),
    );

    const draft = await loadDraft("1741392000000-a7f3");
    expect(draft).toEqual(mockDraft);
    expect(readFile).toHaveBeenCalledWith(
      join(defaultDraftsDir, "1741392000000-a7f3.json"),
      "utf-8",
    );
  });
});

describe("listDrafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when no drafts exist", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const drafts = await listDrafts();
    expect(drafts).toEqual([]);
  });

  it("reads all JSON files and sorts by createdAt", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
      "b.json",
      "a.json",
      "not-json.txt",
    ]);

    const draftA = {
      id: "a",
      createdAt: "2025-03-07T11:00:00.000Z",
      reason: "manual",
      type: "post",
      text: "first",
    };
    const draftB = {
      id: "b",
      createdAt: "2025-03-07T12:00:00.000Z",
      reason: "network",
      type: "post",
      text: "second",
    };

    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(draftB))
      .mockResolvedValueOnce(JSON.stringify(draftA));

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts[0].id).toBe("a");
    expect(drafts[1].id).toBe("b");
  });

  it("skips corrupted files", async () => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(["bad.json"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("not valid json{{{");

    const drafts = await listDrafts();
    expect(drafts).toEqual([]);
  });
});

describe("deleteDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the draft file", async () => {
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await deleteDraft("1741392000000-a7f3");

    expect(unlink).toHaveBeenCalledWith(
      join(defaultDraftsDir, "1741392000000-a7f3.json"),
    );
  });

  it("uses profile-scoped path", async () => {
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await deleteDraft("1741392000000-a7f3", "work");

    expect(unlink).toHaveBeenCalledWith(
      join(mockBase, "drafts-work", "1741392000000-a7f3.json"),
    );
  });
});

describe("resolveDraftId", () => {
  beforeEach(() => vi.clearAllMocks());

  const setupDrafts = (ids: string[]) => {
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
      ids.map((id) => `${id}.json`),
    );
    for (const id of ids) {
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        JSON.stringify({
          id,
          createdAt: "2025-03-07T12:00:00.000Z",
          reason: "manual",
          type: "post",
          text: "test",
        }),
      );
    }
  };

  it("resolves a full ID match", async () => {
    setupDrafts(["1741392000000-a7f3"]);
    const id = await resolveDraftId("1741392000000-a7f3");
    expect(id).toBe("1741392000000-a7f3");
  });

  it("resolves a unique prefix", async () => {
    setupDrafts(["1741392000000-a7f3", "1741395600000-b2e1"]);
    const id = await resolveDraftId("174139200");
    expect(id).toBe("1741392000000-a7f3");
  });

  it("throws on ambiguous prefix", async () => {
    setupDrafts(["1741392000000-a7f3", "1741392000001-b2e1"]);
    await expect(resolveDraftId("174139200")).rejects.toThrow("Ambiguous");
  });

  it("throws when no match found", async () => {
    setupDrafts(["1741392000000-a7f3"]);
    await expect(resolveDraftId("999")).rejects.toThrow("No draft found");
  });
});
