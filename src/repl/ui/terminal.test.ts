import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { detectKittyKeyboard } from "./terminal";

function fakeTerminal(reply?: string) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      if (reply !== undefined) input.write(reply);
      done();
    },
  });
  return { input, written, stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream };
}

afterEach(() => vi.useRealTimers());

describe("detectKittyKeyboard", () => {
  it("detects support when the ?u reply comes before DA1", async () => {
    const t = fakeTerminal("\x1b[?0u\x1b[?62;22c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(true);
    expect(t.written.join("")).toBe("\x1b[?u\x1b[c");
  });
  it("reports no support when only DA1 answers", async () => {
    const t = fakeTerminal("\x1b[?62;22c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(false);
  });
  it("resolves on DA1 before any timer fires", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal("\x1b[?62c");
    await expect(detectKittyKeyboard(t.stdin, t.stdout)).resolves.toBe(false);
  });
  it("leaves no timer behind once DA1 answers", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal("\x1b[?62c");
    await detectKittyKeyboard(t.stdin, t.stdout);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("still reports support when ?u arrives but DA1 never does", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal("\x1b[?0u");
    const result = detectKittyKeyboard(t.stdin, t.stdout);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(true);
  });
  it("times out at 500 ms when nothing answers", async () => {
    vi.useFakeTimers();
    const t = fakeTerminal();
    let settled = false;
    const result = detectKittyKeyboard(t.stdin, t.stdout).then((v) => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });
  it("restores the input stream", async () => {
    const t = fakeTerminal("\x1b[?62c");
    await detectKittyKeyboard(t.stdin, t.stdout);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.input.listenerCount("data")).toBe(0);
    expect(t.input.listenerCount("readable")).toBe(0);
    expect(t.input.isPaused()).toBe(true);
  });
  // Bun stops reading stdin for good once a data listener has consumed it and
  // gone, so Ink's later readable listener gets nothing and the process exits.
  it("reads the reply the way Ink does, never through a data listener", async () => {
    const t = fakeTerminal("\x1b[?62c");
    const on = vi.spyOn(t.input, "on");
    await detectKittyKeyboard(t.stdin, t.stdout);
    expect(on.mock.calls.map(([event]) => event)).not.toContain("data");
  });
});
