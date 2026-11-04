import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionListing } from "@/repl/core/persist";

/** Local time as `YYYY-MM-DDTHH:MM:SS`. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function row(l: SessionListing): [string, string] {
  if (l.state === "unreadable") return [l.id, "unreadable · d to delete"];
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
  const selected = listings[at - 1];
  useInput((input, key) => {
    if (key.upArrow) setAt((i) => Math.max(0, i - 1));
    else if (key.downArrow) setAt((i) => Math.min(listings.length, i + 1));
    else if (key.escape) props.onPick(undefined);
    else if (key.ctrl && input === "c") props.onPick(null);
    else if (key.return && (!selected || selected.state === "ok")) props.onPick(selected?.id);
    else if (input === "d" && selected?.state === "unreadable") {
      void props.onDelete(selected.id).then(() => {
        setListings((all) => all.filter((l) => l !== selected));
        setAt((i) => i - 1);
      });
    }
  });
  return (
    <Box flexDirection="column">
      <Text>Resume a session?</Text>
      <Text inverse={at === 0}>{`${at === 0 ? "›" : " "} + new`}</Text>
      {listings.map((l, i) => {
        const [text, dim] = row(l);
        return (
          <Text key={l.id} inverse={at === i + 1} wrap="truncate">
            {`${at === i + 1 ? "›" : " "} ${text}`}
            <Text dimColor>{dim}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
