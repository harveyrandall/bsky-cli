import { describe, it, expect } from "vitest";
import { detectMimeType, isMp4 } from "@/lib/media";

const bytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const riff = [...bytes("RIFF"), 0, 0, 0, 0];
const ftyp = [0, 0, 0, 0x18, ...bytes("ftyp")];

describe("detectMimeType", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38]],
    ["image/webp", [...riff, ...bytes("WEBP")]],
    ["application/octet-stream", [...riff, ...bytes("WAVE")]],
    ["application/octet-stream", [...riff, ...bytes("AVI ")]],
    ["video/mp4", [...ftyp, ...bytes("isom")]],
    ["application/octet-stream", [0x25, 0x50, 0x44, 0x46]],
  ])("reads %s from its first bytes", (type, bytes) => {
    expect(detectMimeType(new Uint8Array(bytes))).toBe(type);
  });
});

describe("isMp4", () => {
  it.each(["isom", "mp41", "mp42", "avc1", "iso5", "dash"])("accepts %s", (brand) => {
    expect(isMp4(new Uint8Array([...ftyp, ...bytes(brand)]))).toBe(true);
  });
  it.each(["heic", "heix", "mif1", "msf1", "avif", "qt  ", "M4A ", "M4B "])("refuses %s, which only shares the container", (brand) => {
    expect(isMp4(new Uint8Array([...ftyp, ...bytes(brand)]))).toBe(false);
  });
  it("refuses anything else", () => {
    expect(isMp4(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});
