import { lexicons } from "@atproto/api";

interface Limits {
  properties: Record<string, { maxLength?: number; maxSize?: number }>;
}

const props = (id: string) => (lexicons.getDef(id) as unknown as Limits).properties;

// Read from the lexicons, so they follow @atproto/api.
export const maxImages = (): number => props("app.bsky.embed.images").images.maxLength!;
export const maxImageBytes = (): number => props("app.bsky.embed.images#image").image.maxSize!;
export const maxVideoBytes = (): number => props("app.bsky.embed.video").video.maxSize!;
