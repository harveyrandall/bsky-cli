import type { Registry, RegistryEntry } from "./refs";
import type { Failure } from "./pipeline";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h && `${h}h`, (h || m) && `${m}m`, `${s % 60}s`].filter(Boolean).join(" ");
}

/**
 * What the session posted (spec §12). A thread is any group of your posts
 * sharing a root, unless it is a single post that is its own root (standalone).
 */
export function exitSummary(r: {
  registry: Registry;
  failures: readonly Failure[];
  verbose: boolean;
  startedAt: Date;
  endedAt: Date;
  handle: string;
  /** Set if this session can be resumed. */
  resumeId?: string;
}): string[] {
  const own = r.registry.entries().filter((e) => !e.external);
  const byRoot = new Map<string, RegistryEntry[]>();
  for (const e of own) byRoot.set(e.root.uri, [...(byRoot.get(e.root.uri) ?? []), e]);
  const groups = [...byRoot.values()];
  const isStandalone = (g: RegistryEntry[]) => g.length === 1 && g[0].root.uri === g[0].uri;
  const threads = groups.filter((g) => !isStandalone(g));
  const standalone = groups.filter(isStandalone).flat();

  const hint = r.resumeId ? ` · resume: bsky -r ${r.resumeId}` : "";
  const counts =
    own.length === 0
      ? "No posts this session"
      : threads.length === 0
        ? plural(standalone.length, "standalone post")
        : `${plural(own.length, "post")} in ${plural(threads.length, "thread")}` +
          (standalone.length ? `, ${standalone.length} standalone` : "");
  const headline = counts + hint;
  const failed = (f: Failure) =>
    f.draftId ? `Failed: ${plural(f.item.posts.length - f.from, "post")} saved as draft ${f.draftId}` : `Failed: ${f.message}`;
  if (!r.verbose) return [headline, ...r.failures.filter((f) => f.draftId).map(failed)];

  const line = (e: RegistryEntry) => `  ${r.registry.format(e, true)} "${e.excerpt}"`;
  const span = `${r.startedAt.toISOString()} – ${r.endedAt.toISOString()}`;
  return [
    headline,
    `Session ${span} (${duration(r.endedAt.getTime() - r.startedAt.getTime())})${r.handle && ` as @${r.handle}`}`,
    ...threads.flatMap((g) => [`Thread (${g[0].label}):`, ...g.map(line)]),
    ...(standalone.length ? ["Standalone:", ...standalone.map(line)] : []),
    ...r.failures.map(failed),
  ];
}
