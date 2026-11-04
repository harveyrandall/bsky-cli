import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { graphemeLength, trimSuggestions } from "@/lib/split-thread";
import type { SubmitPlan } from "@/repl/core/markers";
import type { Countdown as CountdownState } from "@/repl/core/pipeline";
import { ringCount } from "@/repl/ui/Ring";

/** A picker: ←/→ or Tab move, Enter picks, Esc or Ctrl+C dismisses (undefined). */
export function Choice({
  label,
  options,
  onPick,
}: {
  label: string;
  options: readonly string[];
  onPick(index: number | undefined): void;
}) {
  const [at, setAt] = useState(0);
  useInput((input, key) => {
    if (key.leftArrow) setAt((i) => Math.max(0, i - 1));
    else if (key.rightArrow || key.tab) setAt((i) => Math.min(options.length - 1, i + 1));
    else if (key.return) onPick(at);
    else if (key.escape || (key.ctrl && input === "c")) onPick(undefined);
  });
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Text>
        {options.map((o, i) => (
          <Text key={o} inverse={i === at}>
            {`${i === at ? "›" : " "} ${o}  `}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** The split preview (spec §7). Only `y` or `Y` posts; any other key declines. */
export function SplitPreview({
  plan,
  posts,
  limit,
  onAnswer,
}: {
  plan: SubmitPlan;
  /** What will be posted, labels included. */
  posts: readonly string[];
  limit: number;
  onAnswer(ok: boolean): void;
}) {
  useInput((input) => onAnswer(input === "y" || input === "Y"));
  const source = graphemeLength(plan.source);
  const hints = plan.autoSplit && source > 300 && source <= 375 ? trimSuggestions(plan.source, limit).slice(0, 2) : [];
  return (
    <Box flexDirection="column">
      {posts.map((post, i) => (
        <Box key={i} flexDirection="column">
          <Text dimColor>{`── ${i + 1}/${posts.length} · ${ringCount(graphemeLength(post), 300)} ──`}</Text>
          <Text>{post}</Text>
        </Box>
      ))}
      {plan.keep && <Text>{`Kept for next: ${plan.keep}`}</Text>}
      {plan.discard && <Text dimColor>{`Discarded: ${plan.discard}`}</Text>}
      {hints.map((h) => (
        <Text key={h.preview} dimColor>{`Or trim ${h.charsToRemove} to post it whole: ${h.preview}`}</Text>
      ))}
      <Text>{`Post ${posts.length}? [y/N]`}</Text>
    </Box>
  );
}

/** `Sending in 7s… [Esc] cancel  [Enter] send now` in the undo window; without the keys while pacing. */
export function Countdown({ countdown, now }: { countdown: CountdownState; now: number }) {
  if (countdown.phase === "sending") return <Text dimColor>Sending…</Text>;
  const secs = Math.max(1, Math.ceil((countdown.sendAt - now) / 1000));
  const keys = countdown.phase === "counting" ? " [Esc] cancel  [Enter] send now" : "";
  return <Text dimColor>{`Sending in ${secs}s…${keys}`}</Text>;
}

export type ExitChoice = "send" | "draft" | "discard" | "stay";

/** Ctrl+D with something unsent (spec §10). */
export function ExitPrompt({ onChoose }: { onChoose(choice: ExitChoice): void }) {
  useInput((input, key) => {
    if (input === "s") onChoose("send");
    else if (input === "d") onChoose("draft");
    else if (input === "x") onChoose("discard");
    else if (key.escape || (key.ctrl && input === "c")) onChoose("stay");
  });
  return <Text>[s]end now · save [d]raft · discard [x] · [Esc] stay</Text>;
}
