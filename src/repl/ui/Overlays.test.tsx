import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { TextPrompt, YesNo } from "./Overlays";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function prompt() {
  const onDone = vi.fn();
  const app = render(<TextPrompt label="Alt text:" onDone={onDone} />);
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      app.stdin.write(chunk);
      await tick();
    }
  };
  return { ...app, onDone, type };
}

describe("TextPrompt", () => {
  it("gives what was typed on Enter, and starts empty for the next question", async () => {
    const { type, onDone, lastFrame } = prompt();
    await type("hello", "\r");
    expect(onDone).toHaveBeenCalledWith("hello");
    expect(lastFrame()).not.toContain("hello");
  });
  it("deletes a whole character at a time", async () => {
    const { type, onDone } = prompt();
    await type("hi👍", "\x7f", "\r");
    expect(onDone).toHaveBeenCalledWith("hi");
  });
  it("takes text and Enter that arrive in one chunk", async () => {
    const { type, onDone } = prompt();
    await type("hello\r");
    expect(onDone).toHaveBeenCalledWith("hello");
  });
  it("puts a pasted block on one line", async () => {
    const { type, onDone } = prompt();
    await type("\x1b[200~one\ntwo\x1b[201~", "\r");
    expect(onDone).toHaveBeenCalledWith("one two");
  });
  it.each([["Esc", "\x1b"], ["Ctrl+C", "\x03"]])("gives nothing on %s", async (_, key) => {
    const { type, onDone } = prompt();
    await type("hello", key);
    expect(onDone).toHaveBeenCalledWith(undefined);
  });
});

describe("YesNo", () => {
  it.each([["Enter", "\r", true], ["y", "y", true], ["Y", "Y", true], ["n", "n", false], ["Esc", "\x1b", false]])(
    "takes %s",
    async (_, key, answer) => {
      const onAnswer = vi.fn();
      const app = render(<YesNo label="Attach?" onAnswer={onAnswer} />);
      await tick();
      app.stdin.write(key);
      await tick();
      expect(onAnswer).toHaveBeenCalledWith(answer);
      expect(app.lastFrame()).toContain("Attach? [Y/n]");
    },
  );
});

describe("YesNo defaulting to no", () => {
  it.each([["Enter", "\r", false], ["y", "y", true], ["n", "n", false]])("takes %s", async (_, key, answer) => {
    const onAnswer = vi.fn();
    const app = render(<YesNo label="Delete?" defaultNo onAnswer={onAnswer} />);
    await tick();
    app.stdin.write(key);
    await tick();
    expect(onAnswer).toHaveBeenCalledWith(answer);
    expect(app.lastFrame()).toContain("Delete? [y/N]");
  });
});
