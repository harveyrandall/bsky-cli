import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canStage, chips, expandHome, inspectMedia, nodeMediaFs, parseDroppedPaths, type MediaFs, type StagedMedia } from "./media";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const fs = (size: number | undefined, head = png): MediaFs => ({ size: vi.fn(async () => size), head: vi.fn(async () => head) });

describe("inspectMedia", () => {
  it("accepts images and MP4 video by their first bytes", async () => {
    await expect(inspectMedia("/a.bin", fs(10))).resolves.toEqual({ kind: "image" });
    await expect(inspectMedia("/a.bin", fs(10, mp4))).resolves.toEqual({ kind: "video" });
  });
  it("names a file that isn't there", async () => {
    await expect(inspectMedia("/x/chart.png", fs(undefined))).resolves.toEqual({ error: "chart.png not found" });
  });
  it("reports a file it can't read instead of throwing", async () => {
    const unreadable: MediaFs = { size: async () => 10, head: async () => Promise.reject(new Error("EACCES: permission denied")) };
    await expect(inspectMedia("/x/a.png", unreadable)).resolves.toEqual({ error: "a.png: EACCES: permission denied" });
    const denied: MediaFs = { size: async () => Promise.reject(new Error("EPERM")), head: async () => png };
    await expect(inspectMedia("/x/a.png", denied)).resolves.toEqual({ error: "a.png: EPERM" });
  });
  it("refuses what isn't media", async () => {
    await expect(inspectMedia("/x/a.pdf", fs(10, pdf))).resolves.toEqual({ error: "a.pdf isn't an image or MP4 video" });
  });
  it.each([
    ["an iPhone photo", "a.heic", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]],
    ["a QuickTime movie", "a.mov", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]],
    ["a WAV", "a.wav", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]],
  ])("doesn't mistake %s for media it can post", async (_, name, head) => {
    await expect(inspectMedia(`/x/${name}`, fs(10, new Uint8Array(head)))).resolves.toEqual({ error: `${name} isn't an image or MP4 video` });
  });
  it("holds images and video to their limits", async () => {
    await expect(inspectMedia("/x/a.png", fs(1_000_000))).resolves.toEqual({ kind: "image" });
    await expect(inspectMedia("/x/a.png", fs(1_000_001))).resolves.toEqual({ kind: "image", error: "a.png is over the 1 MB image limit" });
    await expect(inspectMedia("/x/a.mp4", fs(100_000_001, mp4))).resolves.toEqual({ kind: "video", error: "a.mp4 is over the 100 MB video limit" });
  });
});

describe("canStage", () => {
  const image = (n: number): StagedMedia => ({ path: `/${n}.png`, kind: "image" });
  it("allows up to the image limit", () => {
    expect(canStage([image(1), image(2), image(3)], "image")).toBeUndefined();
    expect(canStage([image(1), image(2), image(3), image(4)], "image")).toBe("Only 4 images per post");
  });
  it("never mixes images and video, and allows one video", () => {
    const video: StagedMedia = { path: "/a.mp4", kind: "video" };
    expect(canStage([], "video")).toBeUndefined();
    expect(canStage([image(1)], "video")).toBe("A post can have images or one video, not both");
    expect(canStage([video], "image")).toBe("A post can have images or one video, not both");
    expect(canStage([video], "video")).toBe("Only one video per post");
  });
});

describe("parseDroppedPaths", () => {
  it("reads quoted and escaped paths", () => {
    expect(parseDroppedPaths("'/a b.png'")).toEqual(["/a b.png"]);
    expect(parseDroppedPaths("/a\\ b.png /c.jpg")).toEqual(["/a b.png", "/c.jpg"]);
    expect(parseDroppedPaths("~/d.png\n./e.png ../f.png")).toEqual(["~/d.png", "./e.png", "../f.png"]);
  });
  it("leaves anything else as text", () => {
    expect(parseDroppedPaths("")).toBeUndefined();
    expect(parseDroppedPaths("just some text")).toBeUndefined();
    expect(parseDroppedPaths("/a.png and more")).toBeUndefined();
    expect(parseDroppedPaths("'/unclosed.png")).toBeUndefined();
  });
  it("won't touch a network path just because it was pasted", () => {
    expect(parseDroppedPaths("//server/share/a.png")).toBeUndefined();
    expect(parseDroppedPaths("'\\\\server\\share\\a.png'")).toBeUndefined();
  });
});

describe("chips", () => {
  it("lists file names", () => {
    expect(chips([{ path: "/x/chart.png", kind: "image" }, { path: "/y/photo.jpg", kind: "image" }])).toBe("📎 chart.png · photo.jpg");
  });
});

describe("nodeMediaFs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bsky-media-"));
  it("says there's no such file only when there isn't", async () => {
    await expect(nodeMediaFs.size(join(dir, "missing.png"))).resolves.toBeUndefined();
  });
  it("won't take a folder for a file", async () => {
    await expect(nodeMediaFs.size(dir)).rejects.toThrow("is a folder");
  });
  it("reads a file's size and first bytes", async () => {
    const file = join(dir, "a.bin");
    writeFileSync(file, new Uint8Array(20).fill(7));
    await expect(nodeMediaFs.size(file)).resolves.toBe(20);
    expect((await nodeMediaFs.head(file)).length).toBe(12);
  });
});

describe("expandHome", () => {
  it("expands a leading ~/ only", () => {
    expect(expandHome("~/a.png")).toBe(`${homedir()}/a.png`);
    expect(expandHome("/x/~/a.png")).toBe("/x/~/a.png");
  });
});
