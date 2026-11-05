import { describe, it, expect, vi } from "vitest";
import { dispatch, parseInput } from "./dispatch";
import type { Repl } from "./repl";

function fakeRepl() {
  return {
    submitText: vi.fn(async () => "keep" as const),
    startThread: vi.fn(async () => "done" as const),
    reply: vi.fn(async () => "done" as const),
    replyFrom: vi.fn(async (): Promise<"done" | "keep"> => "done"),
    post: vi.fn(async () => "done" as const),
    setAutoThread: vi.fn(),
    setCooldown: vi.fn(),
    askSettings: vi.fn(async () => {}),
    settingsLine: vi.fn(() => "undo 5s · pace off · auto-thread off"),
    retry: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    detach: vi.fn(),
    quote: vi.fn(async () => "done" as const),
    newMenu: vi.fn(async () => "done" as const),
    engage: vi.fn(async () => "done" as const),
    deletePost: vi.fn(async () => "done" as const),
    undo: vi.fn(async () => "done" as const),
    drafts: vi.fn(async () => "done" as const),
    switchProfile: vi.fn(async () => "done" as const),
    openPost: vi.fn(async () => "done" as const),
    copyPost: vi.fn(async () => "done" as const),
    uriOf: vi.fn(async (_: string): Promise<string | undefined> => "at://x"),
    settings: () => ({ verbose: false }),
    registry: { entries: () => [{ excerpt: "hello" }], format: () => "(1) 3lbx7kt5def2a" },
  };
}
const ctx = () => {
  const repl = fakeRepl();
  return { print: vi.fn(), exit: vi.fn(), edit: vi.fn(async (text: string) => `${text}!`), repl: repl as unknown as Repl, fake: repl };
};
const printed = (c: ReturnType<typeof ctx>) => c.print.mock.calls.map((call) => call[0]).join("\n");

describe("parseInput", () => {
  it("classifies input", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(parseInput("/help exit")).toEqual({ kind: "command", name: "help", rest: "exit" });
    expect(parseInput("/Help")).toEqual({ kind: "text", text: "/Help" });
    expect(parseInput("\\/tmp is a path")).toEqual({ kind: "text", text: "/tmp is a path" });
    expect(parseInput("  \\/tmp")).toEqual({ kind: "text", text: "  /tmp" });
    expect(parseInput("//> keep")).toEqual({ kind: "text", text: "//> keep" });
  });
});

describe("managing posts", () => {
  it("/delete takes a ref, /undo nothing", async () => {
    const c = ctx();
    await dispatch("/delete 2", c);
    await dispatch("/undo", c);
    expect(c.fake.deletePost).toHaveBeenCalledWith("2");
    expect(c.fake.undo).toHaveBeenCalledOnce();
    expect(await dispatch("/delete", c)).toBe("keep");
  });
  it("/drafts lists, or loads one", async () => {
    const c = ctx();
    await dispatch("/drafts", c);
    expect(c.fake.drafts).toHaveBeenLastCalledWith(undefined);
    await dispatch("/drafts 174", c);
    expect(c.fake.drafts).toHaveBeenLastCalledWith("174");
  });
  it("/switch takes a profile, or goes back to the unnamed one", async () => {
    const c = ctx();
    await dispatch("/switch work", c);
    expect(c.fake.switchProfile).toHaveBeenLastCalledWith("work");
    await dispatch("/switch", c);
    expect(c.fake.switchProfile).toHaveBeenLastCalledWith("");
  });
});

describe("/open, /copy and /view", () => {
  it("take a ref", async () => {
    const c = ctx();
    await dispatch("/open 2", c);
    await dispatch("/copy 2", c);
    expect(c.fake.openPost).toHaveBeenCalledWith("2");
    expect(c.fake.copyPost).toHaveBeenCalledWith("2");
    expect(await dispatch("/open", c)).toBe("keep");
    expect(await dispatch("/copy", c)).toBe("keep");
    expect(await dispatch("/view", c)).toBe("keep");
  });
  it("/view prints the thread through the CLI", async () => {
    const run = vi.fn(async (_: string[]) => "done" as const);
    const c = { ...ctx(), passthrough: { names: () => [], knows: () => false, run } };
    expect(await dispatch("/view #2", c)).toBe("done");
    expect(run).toHaveBeenCalledWith(["thread", "at://x"]);
  });
  it("/view keeps the text on a bad ref", async () => {
    const run = vi.fn(async (_: string[]) => "done" as const);
    const c = { ...ctx(), passthrough: { names: () => [], knows: () => false, run } };
    c.fake.uriOf.mockResolvedValueOnce(undefined);
    expect(await dispatch("/view 9", c)).toBe("keep");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("/open failing", () => {
  it("keeps the REPL and the text", async () => {
    const c = ctx();
    c.fake.openPost.mockRejectedValueOnce(new Error("no browser"));
    expect(await dispatch("/open 1", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("/open: no browser", "error");
  });
});

describe("likes and reposts", () => {
  it.each(["like", "unlike", "repost", "unrepost"])("/%s takes a ref", async (name) => {
    const c = ctx();
    await dispatch(`/${name} #2`, c);
    expect(c.fake.engage).toHaveBeenLastCalledWith(name, "#2");
    expect(await dispatch(`/${name}`, c)).toBe("keep");
  });
});

describe("CLI commands", () => {
  const withCli = () => {
    const c = ctx();
    const run = vi.fn(async (_: string[]) => "done" as const);
    return { c: { ...c, passthrough: { names: () => ["timeline", "search", "post"], knows: (n: string) => ["timeline", "search", "post", "login", "tl"].includes(n), run } }, run };
  };
  it("say what became of the text", async () => {
    const { c, run } = withCli();
    run.mockResolvedValueOnce("keep" as never);
    expect(await dispatch("/timeline --nope", c)).toBe("keep");
    run.mockResolvedValueOnce("keep" as never);
    expect(await dispatch("/run timeline --nope", c)).toBe("keep");
  });
  it("reach blocked commands and aliases, which aren't offered but can say why", async () => {
    const { c, run } = withCli();
    await dispatch("/login me", c);
    await dispatch("/tl -n 5", c);
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([["login", "me"], ["tl", "-n", "5"]]);
  });
  it("/help on a blocked command says why", async () => {
    const { c, run } = withCli();
    await dispatch("/help login", c);
    expect(run).toHaveBeenCalledWith(["login", "--help"]);
  });
  it("run when no REPL command has the name, with shell-style arguments", async () => {
    const { c, run } = withCli();
    expect(await dispatch(`/search "two words" -n 5`, c)).toBe("done");
    expect(run).toHaveBeenCalledWith(["search", "two words", "-n", "5"]);
  });
  it("lose to a REPL command of the same name", async () => {
    const { c, run } = withCli();
    await dispatch("/post hi", c);
    expect(run).not.toHaveBeenCalled();
    expect(c.fake.post).toHaveBeenCalledWith("hi");
  });
  it("can be asked for by name with /run", async () => {
    const { c, run } = withCli();
    await dispatch("/run post hi", c);
    expect(run).toHaveBeenCalledWith(["post", "hi"]);
  });
  it("say so if /run has nothing to run", async () => {
    const { c } = withCli();
    expect(await dispatch("/run", c)).toBe("keep");
    expect(printed(c)).toContain("Usage: /run");
    const none = ctx();
    expect(await dispatch("/run timeline", none)).toBe("keep");
    expect(printed(none)).toContain("aren't available");
  });
  it("are suggested for a typo", async () => {
    const { c } = withCli();
    expect(await dispatch("/timelin", c)).toBe("keep");
    expect(printed(c)).toContain("Did you mean /timeline?");
  });
  it("show up in /help, marked, and show their own help", async () => {
    const { c, run } = withCli();
    await dispatch("/help", c);
    expect(printed(c)).toContain("↗ From the CLI: /timeline /search");
    await dispatch("/help timeline", c);
    expect(run).toHaveBeenCalledWith(["timeline", "--help"]);
  });
  it("keep the text if the arguments don't parse", async () => {
    const { c, run } = withCli();
    expect(await dispatch(`/search "open`, c)).toBe("keep");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("media commands", () => {
  it("/attach takes shell-style paths and --alt anywhere", async () => {
    const c = ctx();
    await dispatch(`/attach "/a b.png" /c.png --alt "Two charts"`, c);
    expect(c.fake.attach).toHaveBeenLastCalledWith(["/a b.png", "/c.png"], "Two charts");
    await dispatch("/attach /a.png", c);
    expect(c.fake.attach).toHaveBeenLastCalledWith(["/a.png"], undefined);
    await dispatch(`/attach --alt "A chart" /a.png /b.png`, c);
    expect(c.fake.attach).toHaveBeenLastCalledWith(["/a.png", "/b.png"], "A chart");
  });
  it("/attach needs a path, and --alt its text", async () => {
    const c = ctx();
    expect(await dispatch("/attach", c)).toBe("keep");
    expect(printed(c)).toContain("Usage: /attach");
    expect(await dispatch("/attach /a.png --alt", c)).toBe("keep");
    expect(c.fake.attach).not.toHaveBeenCalled();
  });
  it("/detach takes a number or all, and defaults to all", async () => {
    const c = ctx();
    await dispatch("/detach 2", c);
    expect(c.fake.detach).toHaveBeenLastCalledWith(2);
    await dispatch("/detach all", c);
    expect(c.fake.detach).toHaveBeenLastCalledWith("all");
    await dispatch("/detach", c);
    expect(c.fake.detach).toHaveBeenLastCalledWith("all");
    expect(await dispatch("/detach 0", c)).toBe("keep");
    expect(await dispatch("/detach x", c)).toBe("keep");
    expect(c.fake.detach).toHaveBeenCalledTimes(3);
  });
  it("/quote takes a ref and optional text", async () => {
    const c = ctx();
    await dispatch("/quote 2 look at\nthis", c);
    expect(c.fake.quote).toHaveBeenLastCalledWith("2", "look at\nthis");
    await dispatch("/quote 2", c);
    expect(c.fake.quote).toHaveBeenLastCalledWith("2", undefined);
    expect(await dispatch("/quote", c)).toBe("keep");
  });
  it("/new opens the menu", async () => {
    const c = ctx();
    expect(await dispatch("/new", c)).toBe("done");
    expect(c.fake.newMenu).toHaveBeenCalledOnce();
  });
  it("/edit puts what the editor saved in the composer", async () => {
    const c = ctx();
    expect(await dispatch("/edit some text", c)).toEqual({ restore: "some text!" });
    expect(await dispatch("/edit", c)).toEqual({ restore: "!" });
  });
});

describe("dispatch", () => {
  it("/thread takes quotes off a ref-shaped argument and leaves other quotes in the post", async () => {
    const c = ctx();
    await dispatch('/thread "42"', c);
    expect(c.fake.startThread).toHaveBeenLastCalledWith("42", { asText: true });
    await dispatch('/thread "Hello," she said, "hi"', c);
    expect(c.fake.startThread).toHaveBeenLastCalledWith('"Hello," she said, "hi"', {});
  });
  it("/reply-from keeps the text when it can't go ahead", async () => {
    const c = ctx();
    c.fake.replyFrom.mockResolvedValueOnce("keep");
    expect(await dispatch("/reply-from 9", c)).toBe("keep");
  });
  it("/exit and /quit exit", async () => {
    for (const input of ["/exit", "/quit"]) {
      const c = ctx();
      expect(await dispatch(input, c)).toBe("done");
      expect(c.exit).toHaveBeenCalledOnce();
    }
  });
  it("/help lists every command", async () => {
    const c = ctx();
    expect(await dispatch("/help", c)).toBe("done");
    expect(printed(c)).toContain("/help [command]");
    expect(printed(c)).toContain("/exit");
  });
  it("/help <cmd> shows usage and aliases", async () => {
    const c = ctx();
    await dispatch("/help exit", c);
    expect(printed(c)).toContain("Aliases: /quit");
  });
  it("suggests a close command and keeps the text", async () => {
    const c = ctx();
    expect(await dispatch("/hlp", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /hlp. Did you mean /help?", "error");
  });
  it("points at /help when nothing is close", async () => {
    const c = ctx();
    expect(await dispatch("/zzzz", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("Unknown /zzzz. /help lists commands.", "error");
  });
  it.each([
    ['/help "exit', '/help: Unclosed " quote'],
    ["/help 'exit", "/help: Unclosed ' quote"],
  ])("reports %s as one error line naming the command, and keeps the text", async (input, message) => {
    const c = ctx();
    expect(await dispatch(input, c)).toBe("keep");
    expect(c.print.mock.calls).toEqual([[message, "error"]]);
  });
  it("hands plain text to the session and returns what it says", async () => {
    const c = ctx();
    expect(await dispatch("hello\nworld", c)).toBe("keep");
    expect(c.fake.submitText).toHaveBeenCalledWith("hello\nworld");
  });
});

describe("writing commands", () => {
  it.each([
    ["/thread", [undefined, {}]],
    ["/thread hello there", ["hello there", {}]],
    ["/thread 42", ["42", {}]],
    ['/thread "42"', ["42", { asText: true }]],
    ["/thread --undo 5 --pace 10 don't stop", ["don't stop", { undo: 5, pace: 10 }]],
  ])("%s", async (input, args) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.startThread).toHaveBeenCalledWith(...args);
  });
  it("rejects a cooldown other than 0, 5, 10 or 15", async () => {
    const c = ctx();
    expect(await dispatch("/thread --undo 7 hi", c)).toBe("keep");
    expect(c.print).toHaveBeenCalledWith("/thread: --undo must be 0, 5, 10 or 15", "error");
  });
  it.each([
    ["/reply 3", ["3", undefined]],
    ["/reply 3 thanks, that's it", ["3", "thanks, that's it"]],
  ])("%s", async (input, args) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.reply).toHaveBeenCalledWith(...args);
  });
  it("needs a ref for /reply and /reply-from", async () => {
    const c = ctx();
    await dispatch("/reply", c);
    await dispatch("/reply-from", c);
    expect(c.print).toHaveBeenCalledWith("/reply: Usage: /reply <ref> [text]", "error");
    expect(c.print).toHaveBeenCalledWith("/reply-from: Usage: /reply-from <ref>", "error");
  });
  it("moves the cursor with /reply-from", async () => {
    const c = ctx();
    await dispatch("/reply-from A3", c);
    expect(c.fake.replyFrom).toHaveBeenCalledWith("A3");
  });
  it("keeps a /post's text exactly", async () => {
    const c = ctx();
    await dispatch("/post line one\nline two", c);
    await dispatch("/post", c);
    expect(c.fake.post).toHaveBeenNthCalledWith(1, "line one\nline two");
    expect(c.fake.post).toHaveBeenNthCalledWith(2, undefined);
  });
});

describe("session commands", () => {
  it.each([
    ["/auto-thread", undefined],
    ["/auto-thread on", true],
    ["/auto-thread off", false],
  ])("%s", async (input, value) => {
    const c = ctx();
    await dispatch(input, c);
    expect(c.fake.setAutoThread).toHaveBeenCalledWith(value);
  });
  it("/settings asks with no arguments and sets one directly", async () => {
    const c = ctx();
    await dispatch("/settings", c);
    expect(c.fake.askSettings).toHaveBeenCalled();
    await dispatch("/settings pace 10", c);
    expect(c.fake.setCooldown).toHaveBeenCalledWith("pace", 10);
    expect(c.print).toHaveBeenCalledWith("undo 5s · pace off · auto-thread off");
  });
  it("/history lists the session's posts", async () => {
    const c = ctx();
    await dispatch("/history", c);
    expect(c.print).toHaveBeenCalledWith('(1) 3lbx7kt5def2a "hello"');
  });
  it("/retry resends", async () => {
    const c = ctx();
    await dispatch("/retry", c);
    expect(c.fake.retry).toHaveBeenCalled();
  });
  it("/help lists every command", async () => {
    const c = ctx();
    await dispatch("/help", c);
    for (const name of ["help", "thread", "reply", "reply-from", "post", "auto-thread", "settings", "history", "retry", "exit"]) {
      expect(printed(c)).toContain(`/${name}`);
    }
  });
});
