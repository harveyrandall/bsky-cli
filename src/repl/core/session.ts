import { isEmptySession, type ReplSessionFile, type SessionStore } from "./persist";
import type { Repl } from "./repl";

type Meta = Pick<ReplSessionFile, "id" | "createdAt" | "handle" | "did" | "profile">;

/** The composer, as far as a session keeps it. */
interface Draft {
  text: string;
  cursor: number;
  history: string[];
}

/** One session on disk, from its first save to its last. */
export class SessionKeeper {
  private draft: Draft;
  /** Once there's a file, it has to follow what happens, even if that's nothing left. */
  private written: boolean;
  private ended = false;
  /** Shared by every save, so they land in the order they were asked for. */
  private locked?: Promise<boolean>;

  constructor(
    private readonly store: Pick<SessionStore, "save" | "delete" | "lock" | "unlock" | "prune">,
    private readonly meta: Meta,
    private readonly keep: number,
    /** Already locked, by whoever opened it. */
    resume?: ReplSessionFile,
  ) {
    this.draft = resume ? { ...resume.composer, history: resume.history } : { text: "", cursor: 0, history: [] };
    this.written = resume !== undefined;
    if (resume) this.locked = Promise.resolve(true);
  }

  /** The composer as it is now, which needn't be saved yet. */
  track(draft: Draft): void {
    this.draft = draft;
  }

  async save(repl: Repl): Promise<void> {
    if (!this.ended) await this.write(this.fileOf(repl, this.draft));
  }

  private fileOf(repl: Repl, { text, cursor, history }: Draft): ReplSessionFile {
    return repl.snapshot(this.meta, { text, cursor }, history);
  }

  private async write(file: ReplSessionFile): Promise<void> {
    if (isEmptySession(file) && !this.written) return;
    this.written = true;
    this.locked ??= this.store.lock(this.meta.id);
    await this.locked;
    await this.store.save(file);
  }

  /**
   * Closes the queue and writes the last of the session; nothing is saved after
   * this starts. `left` means you left, so the composer and staged files were dealt
   * with at the exit prompt. Otherwise they're kept, along with what's unsent.
   */
  async end(repl: Repl, left: boolean): Promise<{ resumable: boolean; error?: string }> {
    this.ended = true;
    let file: ReplSessionFile;
    if (left) {
      repl.close();
      await repl.settled();
      file = { ...this.fileOf(repl, { ...this.draft, text: "", cursor: 0 }), staged: [] };
    } else {
      file = this.fileOf(repl, this.draft); // close() empties the queue
      repl.close();
    }
    const resumable = !isEmptySession(file);
    let error: string | undefined;
    try {
      if (resumable) await this.write(file);
      else await this.store.delete(this.meta.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Housekeeping: a failure here doesn't touch the session itself.
    await this.store.unlock(this.meta.id).catch(() => {});
    await this.store.prune(this.keep).catch(() => {});
    return error === undefined ? { resumable } : { resumable: false, error };
  }
}
