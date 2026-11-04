import { describe, it, expect } from "vitest";
import { detectMimeType } from "@/lib/media";

describe("detectMimeType", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]],
    ["video/mp4", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]],
    ["application/octet-stream", [0x25, 0x50, 0x44, 0x46]],
  ])("reads %s from its first bytes", (type, bytes) => {
    expect(detectMimeType(new Uint8Array(bytes))).toBe(type);
  });
});
