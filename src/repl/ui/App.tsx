import { useCallback, useState } from "react";
import { Static, Text, useApp } from "ink";
import type { Markers } from "@/repl/core/markers";
import type { LineStyle } from "@/repl/core/commands";
import { dispatch } from "@/repl/core/dispatch";
import { Composer } from "@/repl/ui/Composer";

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

export function App({ markers, kittyHint }: AppProps) {
  const { exit } = useApp();
  const [log, setLog] = useState<LogLine[]>(() => [
    { id: 0, text: HEADER, style: "normal" },
    ...(kittyHint ? [{ id: 1, text: KITTY_HINT, style: "dim" as const }] : []),
  ]);
  const print = useCallback(
    (text: string, style: LineStyle = "normal") => setLog((l) => [...l, { id: l.length, text, style }]),
    [],
  );
  const leave = useCallback(() => exit(), [exit]);

  return (
    <>
      <Static items={log}>
        {(line) => (
          <Text key={line.id} dimColor={line.style === "dim"} color={line.style === "error" ? "red" : undefined}>
            {line.text}
          </Text>
        )}
      </Static>
      <Composer
        markers={markers}
        onSubmit={(text) => dispatch(text, { print, exit: leave })}
        onHint={(text) => print(text, "dim")}
        onExit={leave}
      />
    </>
  );
}
