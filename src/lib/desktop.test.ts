import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { copyText, openUrl } from "@/lib/desktop";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** A child process that ends how each program's outcome says. */
function programs(outcome: (command: string) => number | "missing") {
  const input: string[] = [];
  vi.mocked(spawn).mockImplementation(((command: string) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: { on() {}, end: (text: string) => void input.push(text) },
    });
    queueMicrotask(() => {
      if (command === undefined) return; // vitest touches the mock itself when reporting
      const result = outcome(command);
      if (result === "missing") child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
      else child.emit("close", result);
    });
    return child;
  }) as never);
  return input;
}

describe("desktop", () => {
  const platform = process.platform;
  const on = (name: string) => Object.defineProperty(process, "platform", { value: name });
  beforeEach(() => vi.mocked(spawn).mockReset());
  afterEach(() => on(platform));

  it.each([
    ["darwin", "open", ["https://x"]],
    ["linux", "xdg-open", ["https://x"]],
    ["win32", "cmd", ["/c", "start", "", "https://x"]],
  ])("opens a link on %s", async (name, command, args) => {
    on(name);
    programs(() => 0);
    await openUrl("https://x");
    expect(spawn).toHaveBeenCalledWith(command, args, expect.anything());
  });
  it("says if a link can't be opened", async () => {
    on("linux");
    programs(() => 3);
    await expect(openUrl("https://x")).rejects.toThrow("xdg-open exited with status 3");
  });
  it("copies with the first tool there is", async () => {
    const input = programs((c) => (c === "pbcopy" ? "missing" : 0));
    await copyText("hello");
    expect(vi.mocked(spawn).mock.calls.map(([c]) => c)).toEqual(["pbcopy", "wl-copy"]);
    expect(input).toEqual(["hello", "hello"]);
  });
  it("says if there's no clipboard tool", async () => {
    programs(() => "missing");
    await expect(copyText("hello")).rejects.toThrow("Couldn't find a clipboard tool (tried pbcopy, wl-copy, xclip, clip)");
  });
  it("stops at a tool that's there but fails", async () => {
    programs(() => 1);
    await expect(copyText("hello")).rejects.toThrow("pbcopy exited with status 1");
  });
});
