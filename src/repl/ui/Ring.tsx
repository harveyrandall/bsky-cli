import { Text } from "ink";
import { graphemeLength } from "@/lib/split-thread";
import type { Segment } from "@/repl/core/markers";

export function ringGlyph(count: number, limit: number): string {
  const share = count / limit;
  if (share < 0.2) return "○";
  if (share < 0.5) return "◔";
  if (share < 0.75) return "◑";
  if (share < 1) return "◕";
  return "●";
}

export function ringColor(count: number, limit: number): "green" | "yellow" | "red" {
  if (count < limit - 40) return "green";
  return count <= limit ? "yellow" : "red";
}

export function ringCount(count: number, limit: number): string {
  // U+2212 MINUS SIGN, not a hyphen.
  return count > limit ? `${count}/${limit} (−${count - limit})` : `${count}/${limit}`;
}

/** Status line for the segment under the cursor. PR 2 passes 298 for labelled posts. */
export function Ring({ segment, limit = 300 }: { segment: Segment; limit?: number }) {
  if (segment.region !== "send") return <Text dimColor>{segment.region}</Text>;
  const count = graphemeLength(segment.text);
  return (
    <Text>
      {segment.total > 1 ? `segment ${segment.index}/${segment.total}  ` : ""}
      <Text color={ringColor(count, limit)}>
        {ringGlyph(count, limit)} {ringCount(count, limit)}
      </Text>
    </Text>
  );
}
