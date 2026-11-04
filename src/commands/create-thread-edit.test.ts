import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { createMockAgent } from "@/test-utils";

const { answers, editInEditor } = vi.hoisted(() => ({ answers: [] as string[], editInEditor: vi.fn() }));
const mockAgent = createMockAgent();
vi.mock("@/index", () => ({ getClient: vi.fn(() => Promise.resolve(mockAgent)), isJson: vi.fn(() => false) }));
vi.mock("@/drafts", () => ({ saveDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock("@/lib/editor", () => ({ editInEditor }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => answers.shift() ?? "n", close() {} }),
}));

import { registerCreateThread } from "./create-thread";

describe("create-thread preview", () => {
  const tty = process.stdin.isTTY;
  afterEach(() => Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true }));

  it("reports an editor that fails and goes back to the preview", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    editInEditor.mockRejectedValueOnce(new Error("Couldn't open nano: ENOENT"));
    answers.push("e 1", "q");
    const program = new Command().exitOverride().option("--json").option("-p, --profile <name>");
    registerCreateThread(program);
    await program.parseAsync(["node", "test", "create-thread", "one /// two"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Couldn't open nano"));
    expect(answers).toEqual([]);
    err.mockRestore();
  });
});
