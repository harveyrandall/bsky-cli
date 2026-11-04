import { useCallback, useEffect, useReducer, useState } from "react";
import { Static, Text, useApp } from "ink";
import type { Markers, SubmitPlan } from "@/repl/core/markers";
import type { LineStyle } from "@/repl/core/commands";
import { dispatch } from "@/repl/core/dispatch";
import { Repl, type ReplAgent, type ReplDeps, type ReplSettings } from "@/repl/core/repl";
import type { Cooldown } from "@/repl/core/types";
import { Composer } from "@/repl/ui/Composer";
import { Choice, Countdown, ExitPrompt, SplitPreview, type ExitChoice } from "@/repl/ui/Overlays";

export const HEADER = "bsky repl · /help for commands · Ctrl+D to exit";
export const KITTY_HINT =
  "This terminal can't tell Shift+Enter from Enter — use Alt+Enter or Ctrl+J for new lines.";

/** What waitUntilExit resolves with when the user leaves, rather than Ink stopping. */
export const LEFT = Symbol("left");

const COOLDOWNS = [0, 5, 10, 15] as const;
const showCooldown = (v: Cooldown) => (v === 0 ? "off" : `${v}s`);

export interface AppProps {
  markers: Markers;
  kittyHint: boolean;
  settings: ReplSettings;
  agent: ReplAgent;
  drafts: { save: ReplDeps["saveDraft"]; delete: ReplDeps["deleteDraft"] };
  saveConfig: ReplDeps["saveConfig"];
  /** The config file's name, for the save offer. */
  configName: string;
  onReady?(repl: Repl): void;
}

interface LogLine {
  id: number;
  text: string;
  style: LineStyle;
}

type Overlay =
  | { kind: "cooldown"; which: "undo" | "pace"; resolve(v: Cooldown | undefined): void }
  | { kind: "save"; values: { undo?: Cooldown; pace?: Cooldown }; resolve(a: "yes" | "no" | "never"): void }
  | { kind: "preview"; plan: SubmitPlan; labelled: boolean; resolve(ok: boolean): void }
  | { kind: "exit"; text: string };

export function App(props: AppProps) {
  const { markers, kittyHint } = props;
  const { exit } = useApp();
  const [log, setLog] = useState<LogLine[]>(() => [
    { id: 0, text: HEADER, style: "normal" },
    ...(kittyHint ? [{ id: 1, text: KITTY_HINT, style: "dim" as const }] : []),
  ]);
  const print = useCallback(
    (text: string, style: LineStyle = "normal") => setLog((l) => [...l, { id: l.length, text, style }]),
    [],
  );
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [overlay, setOverlay] = useState<Overlay>();
  const [restore, setRestore] = useState<{ id: number; text: string }>();
  const [exitWhenSent, setExitWhenSent] = useState(false);

  const [repl] = useState(
    () =>
      new Repl(props.settings, markers, {
        agent: props.agent,
        ask: {
          cooldown: (which) => new Promise((resolve) => setOverlay({ kind: "cooldown", which, resolve })),
          saveOffer: (values) => new Promise((resolve) => setOverlay({ kind: "save", values, resolve })),
          confirm: (plan, labelled) => new Promise((resolve) => setOverlay({ kind: "preview", plan, labelled, resolve })),
        },
        print,
        onChange: rerender,
        restore: (text) => {
          // Something came back: don't leave with it.
          setExitWhenSent(false);
          setRestore((r) => ({ id: (r?.id ?? 0) + 1, text }));
        },
        saveDraft: props.drafts.save,
        deleteDraft: props.drafts.delete,
        saveConfig: props.saveConfig,
      }),
  );
  useEffect(() => props.onReady?.(repl), [repl]);
  // Leaving always stops the queue, so nothing is posted after the REPL closes.
  const leave = useCallback(() => {
    repl.close();
    exit(LEFT);
  }, [exit, repl]);
  // Ctrl+D on an empty composer and /exit: ask first if posts are still waiting.
  const requestExit = (text: string) => (repl.wouldLose(text) ? setOverlay({ kind: "exit", text }) : leave());

  const pendingCount = repl.pendingCount();
  // Tick the countdown while anything is queued.
  useEffect(() => {
    if (pendingCount === 0) return;
    const timer = setInterval(rerender, 250);
    return () => clearInterval(timer);
  }, [pendingCount > 0]);
  useEffect(() => {
    if (exitWhenSent && pendingCount === 0) leave();
  }, [exitWhenSent, pendingCount]);

  const close = () => setOverlay(undefined);

  // Text that came back while the composer was busy: keep both.
  const keepAsDraft = async (text: string) => {
    try {
      const d = await props.drafts.save({ reason: "manual", type: "post", text });
      print(`A post came back while you were typing; saved it as draft ${d.id}`, "dim");
    } catch (err) {
      print(`A post came back but couldn't be saved as a draft (${err instanceof Error ? err.message : String(err)}):`, "error");
      print(text);
    }
  };

  const chooseExit = async (choice: ExitChoice, text: string) => {
    close();
    if (choice === "stay") return;
    if (choice === "send") {
      if (repl.pausedBy()) {
        print("Can't send now: the queue is paused after an error — /retry first, or choose save [d]raft.", "error");
        return;
      }
      // Sending what's queued; unsent composer text is kept as a draft rather than posted mid-exit.
      if (text.trim() !== "") {
        try {
          const d = await props.drafts.save({ reason: "manual", type: "post", text });
          print(`Saved as draft ${d.id}`, "dim");
        } catch (err) {
          print(`Couldn't save drafts (${err instanceof Error ? err.message : String(err)}); still here`, "error");
          return;
        }
      }
      repl.sendNow();
      setExitWhenSent(true);
      return;
    }
    if (choice === "draft") {
      // Save first; only leave (which cancels the queue) once everything is safe.
      const drafts = repl.draftItems();
      if (text.trim() !== "") drafts.push({ reason: "manual", type: "post", text });
      try {
        for (const draft of drafts) {
          const d = await props.drafts.save(draft);
          print(`Saved as draft ${d.id}`, "dim");
        }
      } catch (err) {
        print(`Couldn't save drafts (${err instanceof Error ? err.message : String(err)}); still here`, "error");
        return;
      }
    }
    leave();
  };

  const overlayView = (() => {
    if (!overlay) return null;
    switch (overlay.kind) {
      case "cooldown":
        return (
          <Choice
            label={overlay.which === "undo" ? "Undo window before each post?" : "Minimum time between posts?"}
            options={["none", "5s", "10s", "15s"]}
            onPick={(i) => {
              close();
              overlay.resolve(i === undefined ? undefined : COOLDOWNS[i]);
            }}
          />
        );
      case "save": {
        const parts = (["undo", "pace"] as const).flatMap((k) => {
          const v = overlay.values[k];
          return v === undefined ? [] : [`${k} ${showCooldown(v)}`];
        });
        return (
          <Choice
            label={`Save ${parts.join(" · ")} as your defaults in ${props.configName}?`}
            options={["Yes", "No", "No, don't ask again"]}
            onPick={(i) => {
              close();
              overlay.resolve(i === 0 ? "yes" : i === 2 ? "never" : "no");
            }}
          />
        );
      }
      case "preview":
        return (
          <SplitPreview
            plan={overlay.plan}
            posts={overlay.labelled ? repl.labelPosts(overlay.plan.posts) : overlay.plan.posts}
            limit={overlay.labelled ? 298 : 300}
            onAnswer={(ok) => {
              close();
              overlay.resolve(ok);
            }}
          />
        );
      case "exit":
        return <ExitPrompt onChoose={(c) => void chooseExit(c, overlay.text)} />;
    }
  })();

  const countdown = repl.countdown();
  const failure = repl.pausedBy();
  const pending = countdown?.phase === "counting" ? countdown.item.posts.join(` ${markers.split} `) : undefined;

  return (
    <>
      <Static items={log}>
        {(line) => (
          <Text key={line.id} dimColor={line.style === "dim"} color={line.style === "error" ? "red" : undefined}>
            {line.text}
          </Text>
        )}
      </Static>
      {overlayView}
      <Composer
        markers={markers}
        prompt={repl.prompt()}
        limit={repl.composerLimit()}
        pending={pending}
        active={!overlay}
        restore={restore}
        onRestoreBusy={(text) => void keepAsDraft(text)}
        onSubmit={(text) => dispatch(text, { print, exit: () => requestExit(""), repl })}
        onEscape={(text) => {
          setExitWhenSent(false);
          return repl.escape(text);
        }}
        onInterrupt={(text) => repl.interrupt(text)}
        onEof={requestExit}
        onSendNow={() => repl.sendNow()}
        onHint={(text) => print(text, "dim")}
        onError={(text) => print(text, "error")}
      />
      {countdown && <Countdown countdown={countdown} now={Date.now()} />}
      {exitWhenSent && <Text dimColor>Leaving once everything is sent — Esc to stay</Text>}
      {failure && (
        <Text color="yellow">
          {failure.kind === "expired"
            ? "Paused: session expired — exit and run `bsky login`, or Esc to cancel what's queued"
            : "Paused after a network error — /retry to resend it, Esc to cancel what's queued"}
        </Text>
      )}
    </>
  );
}
