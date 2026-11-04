import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Static, Text, useApp } from "ink";
import { basename } from "node:path";
import type { Markers, SubmitPlan } from "@/repl/core/markers";
import { chips, parseDroppedPaths, type StagedMedia } from "@/repl/core/media";
import type { LineStyle } from "@/repl/core/commands";
import { dispatch } from "@/repl/core/dispatch";
import { editInEditor } from "@/lib/editor";
import { Repl, type ReplAgent, type ReplDeps, type ReplSettings } from "@/repl/core/repl";
import type { Cooldown } from "@/repl/core/types";
import { Composer } from "@/repl/ui/Composer";
import { Choice, Countdown, ExitPrompt, SplitPreview, TextPrompt, YesNo, type ExitChoice } from "@/repl/ui/Overlays";

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
  saveScheduled: ReplDeps["saveScheduled"];
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
  | { kind: "preview"; plan: SubmitPlan; labelled: boolean; media: readonly StagedMedia[]; resolve(ok: boolean): void }
  | { kind: "choice"; label: string; options: readonly string[]; resolve(i: number | undefined): void }
  | { kind: "text"; label: string; resolve(text: string | undefined): void }
  | { kind: "drop"; paths: readonly string[]; resolve(ok: boolean): void }
  | { kind: "exit"; text: string };

export function App(props: AppProps) {
  const { markers, kittyHint } = props;
  const { exit, suspendTerminal } = useApp();
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
  const fillComposer = (text: string) => setRestore((r) => ({ id: (r?.id ?? 0) + 1, text }));
  const composerText = useRef("");

  const [repl] = useState(
    () =>
      new Repl(props.settings, markers, {
        agent: props.agent,
        ask: {
          cooldown: (which) => new Promise((resolve) => setOverlay({ kind: "cooldown", which, resolve })),
          saveOffer: (values) => new Promise((resolve) => setOverlay({ kind: "save", values, resolve })),
          confirm: (plan, labelled, media) => new Promise((resolve) => setOverlay({ kind: "preview", plan, labelled, media, resolve })),
          alt: (file, required) =>
            new Promise((resolve) =>
              setOverlay({
                kind: "text",
                label: `Alt text for ${file} (${required ? "required; Esc drops the file" : "Enter to skip"}):`,
                resolve: (text) => resolve(text === undefined ? null : text.trim() === "" ? undefined : text),
              }),
            ),
          choose: (label, options) => new Promise((resolve) => setOverlay({ kind: "choice", label, options, resolve })),
          text: (label) => new Promise((resolve) => setOverlay({ kind: "text", label, resolve })),
        },
        print,
        onChange: rerender,
        restore: (text) => {
          // Something came back: don't leave with it.
          setExitWhenSent(false);
          fillComposer(text);
        },
        saveDraft: props.drafts.save,
        deleteDraft: props.drafts.delete,
        saveConfig: props.saveConfig,
        saveScheduled: props.saveScheduled,
        composerBusy: () => composerText.current.trim() !== "",
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

  // The editor gets the terminal to itself; Ink restores its modes afterwards.
  const edit = async (text: string) => {
    let edited = text;
    await suspendTerminal(async () => {
      edited = await editInEditor(text);
    });
    return edited;
  };

  // A paste of media paths: ask to attach them. Anything else, or a no, is text after all.
  const offerDrop = async (paths: readonly string[], text: string) => {
    try {
      const attach =
        (await repl.areMedia(paths)) && (await new Promise<boolean>((resolve) => setOverlay({ kind: "drop", paths, resolve })));
      if (attach) await repl.attach(paths);
      else fillComposer(text);
    } catch (err) {
      print(err instanceof Error ? err.message : String(err), "error");
      fillComposer(text);
    }
  };
  const takePaste = (text: string) => {
    const paths = parseDroppedPaths(text);
    if (paths) void offerDrop(paths, text);
    return paths !== undefined;
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
      const unsent = repl.composerDraft(text);
      if (unsent) {
        try {
          const d = await props.drafts.save(unsent);
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
      const unsent = repl.composerDraft(text);
      if (unsent) drafts.push(unsent);
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
            key={overlay.which}
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
            media={overlay.media}
            limit={overlay.labelled ? 298 : 300}
            onAnswer={(ok) => {
              close();
              overlay.resolve(ok);
            }}
          />
        );
      case "choice":
        return (
          <Choice
            key={overlay.label}
            label={overlay.label}
            options={overlay.options}
            onPick={(i) => {
              close();
              overlay.resolve(i);
            }}
          />
        );
      case "text":
        return (
          <TextPrompt
            label={overlay.label}
            onDone={(text) => {
              close();
              overlay.resolve(text);
            }}
          />
        );
      case "drop": {
        const more = overlay.paths.length > 1 ? ` and ${overlay.paths.length - 1} more` : "";
        return (
          <YesNo
            label={`Attach ${basename(overlay.paths[0])}${more}?`}
            onAnswer={(ok) => {
              close();
              overlay.resolve(ok);
            }}
          />
        );
      }
      case "exit":
        return <ExitPrompt onChoose={(c) => void chooseExit(c, overlay.text)} />;
    }
  })();

  const countdown = repl.countdown();
  const failure = repl.pausedBy();

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
        pending={repl.waiting()}
        active={!overlay}
        chips={repl.staged().length > 0 ? chips(repl.staged()) : undefined}
        restore={restore}
        onText={(text) => (composerText.current = text)}
        onSubmit={(text) => dispatch(text, { print, exit: () => requestExit(""), edit, repl })}
        onEscape={(text) => {
          setExitWhenSent(false);
          return repl.escape(text);
        }}
        onInterrupt={(text) => repl.interrupt(text)}
        onEof={requestExit}
        onSendNow={() => repl.sendNow()}
        onEdit={edit}
        onPaste={takePaste}
        onHint={(text) => print(text, "dim")}
        onError={(text) => print(text, "error")}
      />
      {countdown && <Countdown countdown={countdown} now={Date.now()} />}
      {exitWhenSent && <Text dimColor>Leaving once everything is sent — Esc to stay</Text>}
      {failure && (
        <Text color="yellow">
          {failure.kind === "expired"
            ? "Paused: session expired — exit and run `bsky login`, or Esc to cancel what's queued"
            : failure.kind === "limited"
              ? "Paused: rate limited — /retry to resend it later, Esc to cancel what's queued"
              : "Paused after a network error — /retry to resend it, Esc to cancel what's queued"}
        </Text>
      )}
    </>
  );
}
