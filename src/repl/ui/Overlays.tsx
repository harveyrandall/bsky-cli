import { useReducer, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { graphemeLength, trimSuggestions } from "@/lib/split-thread";
import type { SubmitPlan } from "@/repl/core/markers";
import { chips, type StagedMedia } from "@/repl/core/media";
import type { Countdown as CountdownState } from "@/repl/core/pipeline";
import { ringCount } from "@/repl/ui/Ring";

const segmenter = new Intl.Segmenter();

/** A picker: ←/→ or Tab move, Enter picks, Esc or Ctrl+C dismisses (undefined). */
export function Choice({
  label,
  options,
  start = 0,
  onPick,
}: {
  label: string;
  options: readonly string[];
  start?: number;
  onPick(index: number | undefined): void;
}) {
  const [at, setAt] = useState(start);
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
  media,
  limit,
  onAnswer,
}: {
  plan: SubmitPlan;
  /** What will be posted, labels included. */
  posts: readonly string[];
  /** Goes with the first post. */
  media: readonly StagedMedia[];
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
          {i === 0 && media.length > 0 && <Text dimColor>{chips(media)}</Text>}
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

/** A line of text: Enter gives it, Esc or Ctrl+C gives undefined. */
export function TextPrompt({ label, onDone }: { label: string; onDone(text: string | undefined): void }) {
  // In a ref, so keys that arrive in one stdin chunk each see the last one's text.
  const text = useRef("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const set = (value: string) => {
    text.current = value;
    rerender();
  };
  const done = (value: string | undefined) => {
    set(""); // the next question can reuse this prompt
    onDone(value);
  };
  useInput((input, key) => {
    const line = /^([^\r\n]*)[\r\n]/.exec(input);
    if (key.return || line) done(text.current + (line?.[1] ?? ""));
    else if (key.escape || (key.ctrl && input === "c")) done(undefined);
    else if (key.backspace || key.delete) set([...segmenter.segment(text.current)].slice(0, -1).map((g) => g.segment).join(""));
    else if (!key.ctrl && !key.meta) set(text.current + input);
  });
  usePaste((pasted) => set(text.current + pasted.replace(/\s*\n\s*/g, " ")));
  return (
    <Text>
      {`${label} ${text.current}`}
      <Text inverse> </Text>
    </Text>
  );
}

/** `Attach chart.png? [Y/n]`: `y` for yes, and Enter for the default. Any other key is no. */
export function YesNo({ label, defaultNo, onAnswer }: { label: string; defaultNo?: boolean; onAnswer(ok: boolean): void }) {
  useInput((input, key) => onAnswer((key.return && !defaultNo) || input === "y" || input === "Y"));
  return <Text>{`${label} ${defaultNo ? "[y/N]" : "[Y/n]"}`}</Text>;
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
