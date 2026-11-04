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
 * What the session posted (spec §12). A thread is a root with two or more of
 * your posts, or your replies under someone else's post; a single post on its
 * own is standalone.
 */
export function exitSummary(r: {
  registry: Registry;
  failures: readonly Failure[];
  verbose: boolean;
  startedAt: Date;
  endedAt: Date;
  handle: string;
}): string[] {
  const own = r.registry.entries().filter((e) => !e.external);
  const byRoot = new Map<string, RegistryEntry[]>();
  for (const e of own) byRoot.set(e.root.uri, [...(byRoot.get(e.root.uri) ?? []), e]);
  const groups = [...byRoot.values()];
  const isStandalone = (g: RegistryEntry[]) => g.length === 1 && g[0].root.uri === g[0].uri;
  const threads = groups.filter((g) => !isStandalone(g));
  const standalone = groups.filter(isStandalone).flat();

  const counts =
    own.length === 0
      ? "No posts this session"
      : threads.length === 0
        ? plural(standalone.length, "standalone post")
        : `${plural(own.length, "post")} in ${plural(threads.length, "thread")}` +
          (standalone.length ? `, ${standalone.length} standalone` : "");
  if (!r.verbose) return [counts];

  const line = (e: RegistryEntry) => `  ${r.registry.format(e, true)} "${e.excerpt}"`;
  const span = `${r.startedAt.toISOString()} – ${r.endedAt.toISOString()}`;
  return [
    counts,
    `Session ${span} (${duration(r.endedAt.getTime() - r.startedAt.getTime())})${r.handle && ` as @${r.handle}`}`,
    ...threads.flatMap((g) => [`Thread (${g[0].label}):`, ...g.map(line)]),
    ...(standalone.length ? ["Standalone:", ...standalone.map(line)] : []),
    ...r.failures.map((f) =>
      f.draftId ? `Failed: ${plural(f.item.posts.length - f.from, "post")} saved as draft ${f.draftId}` : `Failed: ${f.message}`,
    ),
  ];
}
