import { useState } from "react";
import { Static, Text } from "ink";
import type { Markers } from "@/repl/core/markers";
import type { LineStyle } from "@/repl/core/commands";

export const HEADER = "bsky repl · /help for commands · Ctrl+D to exit";
export const KITTY_HINT =
  "This terminal can't tell Shift+Enter from Enter — use Alt+Enter or Ctrl+J for new lines.";

export interface AppProps {
  markers: Markers;
  kittyHint: boolean;
}

interface LogLine {
  id: number;
  text: string;
  style: LineStyle;
}

export function App({ kittyHint }: AppProps) {
  const [log] = useState<LogLine[]>(() => [
    { id: 0, text: HEADER, style: "normal" },
    ...(kittyHint ? [{ id: 1, text: KITTY_HINT, style: "dim" as const }] : []),
  ]);
  return (
    <>
      <Static items={log}>
        {(line) => (
          <Text key={line.id} dimColor={line.style === "dim"} color={line.style === "error" ? "red" : undefined}>
            {line.text}
          </Text>
        )}
      </Static>
      <Text>bsky › </Text>
    </>
  );
}
