import { useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { SessionListing } from "@/repl/core/persist";

/** Local time as `YYYY-MM-DDTHH:MM:SS`. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function row(l: SessionListing): [string, string] {
  if (l.state === "unreadable") return [`${l.id}  `, "unreadable · d to delete"];
  return [`${localStamp(l.updatedAt!)}  ${l.id}  `, l.state === "in use" ? `in use · ${l.summary}` : l.summary];
}

/** Spec §12: `+ new` first and selected; undefined means new, null means quit. */
export function LaunchList(props: {
  listings: readonly SessionListing[];
  onPick(id: string | undefined | null): void;
  onDelete(id: string): Promise<void>;
}) {
  const [listings, setListings] = useState(props.listings);
  const [at, setAt] = useState(0);
  const [problem, setProblem] = useState<string>();
  const { rows } = useWindowSize();
  const selected = listings[at - 1];
  // Taller than the window, Ink would rewrite the whole frame on every key, and the top would scroll off.
  const room = Math.max(1, rows - 6);
  const first = Math.max(0, Math.min(at - 1 - Math.floor(room / 2), listings.length - room));
  const shown = listings.slice(first, first + room);
  const hidden = (n: number, arrow: string) => n > 0 && <Text dimColor>{`  ${arrow} ${n} more`}</Text>;
  useInput((input, key) => {
    if (key.upArrow) setAt((i) => Math.max(0, i - 1));
    else if (key.downArrow) setAt((i) => Math.min(listings.length, i + 1));
    else if (key.escape) props.onPick(undefined);
    else if (key.ctrl && input === "c") props.onPick(null);
    else if (key.return && (!selected || selected.state === "ok")) props.onPick(selected?.id);
    else if (input === "d" && selected?.state === "unreadable") {
      props.onDelete(selected.id).then(
        () => {
          setListings((all) => all.filter((l) => l !== selected));
          setAt(0);
        },
        (err: unknown) => setProblem(`Couldn't delete ${selected.id} (${err instanceof Error ? err.message : String(err)})`),
      );
    }
  });
  return (
    <Box flexDirection="column">
      <Text>Resume a session?</Text>
      <Text inverse={at === 0}>{`${at === 0 ? "›" : " "} + new`}</Text>
      {hidden(first, "↑")}
      {shown.map((l, i) => {
        const [text, dim] = row(l);
        const here = at === first + i + 1;
        return (
          <Text key={l.id} inverse={here} wrap="truncate">
            {`${here ? "›" : " "} ${text}`}
            <Text dimColor>{dim}</Text>
          </Text>
        );
      })}
      {hidden(listings.length - first - shown.length, "↓")}
      {problem && <Text color="red">{problem}</Text>}
    </Box>
  );
}
