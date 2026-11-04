/** A file's type, from its first bytes. */
export function detectMimeType(data: Uint8Array): string {
  // Check magic bytes for common formats
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "image/png";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46)
    return "image/gif";
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  )
    return "image/webp";
  // Video formats
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79)
    return "video/mp4";
  return "application/octet-stream";
}
