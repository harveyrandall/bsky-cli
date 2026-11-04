import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { LaunchList, localStamp } from "./LaunchList";
import type { SessionListing } from "@/repl/core/persist";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const DOWN = "\x1b[B";

const listings: SessionListing[] = [
  { id: "k3f7xq", updatedAt: "2026-10-31T14:05:22.000Z", summary: '@you · 2 threads, 7 posts · "Launch day"', state: "ok" },
  { id: "p2m2wd", updatedAt: "2026-10-30T21:40:03.000Z", summary: "@you · 1 thread, 3 posts", state: "in use" },
  { id: "zzzzzz", summary: "", state: "unreadable" },
];

function setup() {
  const onPick = vi.fn();
  const onDelete = vi.fn(async () => {});
  const app = render(<LaunchList listings={listings} onPick={onPick} onDelete={onDelete} />);
  const type = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await tick();
    }
  };
  return { ...app, onPick, onDelete, type };
}

describe("LaunchList", () => {
  it("shows every session, with new first and selected", async () => {
    const { lastFrame, type, onPick } = setup();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Resume a session?");
    expect(frame).toContain("› + new");
    expect(frame).toContain(`${localStamp("2026-10-31T14:05:22.000Z")}  k3f7xq  @you · 2 threads, 7 posts · "Launch day"`);
    expect(frame).toContain("p2m2wd");
    expect(frame).toContain("in use");
    expect(frame).toContain("unreadable");
    await tick();
    await type("\r");
    expect(onPick).toHaveBeenCalledWith(undefined);
  });
  it("opens a session", async () => {
    const { type, onPick } = setup();
    await tick();
    await type(DOWN, "\r");
    expect(onPick).toHaveBeenCalledWith("k3f7xq");
  });
  it("won't open one in use, or one it can't read", async () => {
    const { type, onPick } = setup();
    await tick();
    await type(DOWN, DOWN, "\r", DOWN, "\r");
    expect(onPick).not.toHaveBeenCalled();
  });
  it("deletes an unreadable session with d, and only that", async () => {
    const { type, lastFrame, onDelete } = setup();
    await tick();
    await type(DOWN, "d", DOWN, "d");
    expect(onDelete).not.toHaveBeenCalled();
    await type(DOWN, "d");
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("zzzzzz");
    await tick();
    expect(lastFrame()).not.toContain("zzzzzz");
  });
  it("starts new on Esc, and quits on Ctrl+C", async () => {
    const esc = setup();
    await tick();
    await esc.type("\x1b");
    expect(esc.onPick).toHaveBeenCalledWith(undefined);
    const ctrlC = setup();
    await tick();
    await ctrlC.type("\x03");
    expect(ctrlC.onPick).toHaveBeenCalledWith(null);
  });
});

describe("localStamp", () => {
  it("is local time to the second, with no zone", () => {
    expect(localStamp(new Date(2026, 9, 31, 14, 5, 22).toISOString())).toBe("2026-10-31T14:05:22");
  });
});
