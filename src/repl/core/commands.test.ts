import { describe, it, expect } from "vitest";
import { COMMANDS, tokenize, suggest, complete, completeCommand, type Completions } from "./commands";

describe("tokenize", () => {
  it("splits like a shell", () => {
    expect(tokenize(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(tokenize(`"say \\"hi\\""`)).toEqual([`say "hi"`]);
    expect(tokenize(`'no \\escape'`)).toEqual(["no \\escape"]);
    expect(tokenize(`a"b c"`)).toEqual(["ab c"]);
    expect(tokenize("  spaced   out  ")).toEqual(["spaced", "out"]);
    expect(tokenize(`""`)).toEqual([""]);
    expect(tokenize("trailing\\")).toEqual(["trailing\\"]);
  });
  it("rejects an unclosed quote", () => {
    expect(() => tokenize(`"open`)).toThrow('Unclosed " quote');
    expect(() => tokenize(`'open`)).toThrow("Unclosed ' quote");
  });
});

describe("suggest", () => {
  it("finds the closest name within distance 2", () => {
    expect(suggest("hlp", ["exit", "help", "quit"])).toBe("help");
    expect(suggest("zzzzz", ["exit", "help", "quit"])).toBeUndefined();
  });
});

describe("completeCommand", () => {
  it("completes a unique command name", () => {
    expect(completeCommand("/he", 3)).toEqual({ text: "/help ", cursor: 6, candidates: [] });
    expect(completeCommand("/ex", 3)).toEqual({ text: "/exit ", cursor: 6, candidates: [] });
  });
  it("lists candidates when it can't extend", () => {
    const re = completeCommand("/re", 3);
    expect(re).toMatchObject({ text: "/re", cursor: 3 });
    expect(re.candidates).toEqual(expect.arrayContaining(["reply", "reply-from", "retry"]));
    expect(completeCommand("/repl", 5)).toMatchObject({ text: "/reply", cursor: 6 });
    const reply = completeCommand("/reply", 6);
    expect(reply).toMatchObject({ text: "/reply", cursor: 6 });
    expect(reply.candidates).toEqual(expect.arrayContaining(["reply", "reply-from"]));
  });
  it("completes CLI commands too", () => {
    expect(completeCommand("/timel", 6, ["timeline"])).toMatchObject({ text: "/timeline " });
  });
  it("leaves other text alone", () => {
    expect(completeCommand("/x", 2)).toEqual({ text: "/x", cursor: 2, candidates: [] });
    expect(completeCommand("hello", 5)).toEqual({ text: "hello", cursor: 5, candidates: [] });
    expect(completeCommand("/help ex", 8)).toEqual({ text: "/help ex", cursor: 8, candidates: [] });
  });
});

describe("complete", () => {
  const sources: Completions = {
    cliNames: ["timeline"],
    flags: (name) => (name === "timeline" ? ["--json", "--limit"] : []),
    labels: () => ["3", "2", "A1", "#7", "#6"],
    paths: (partial) => ["~/My Pics/", "~/My Pics.txt", "~/docs/", "~/notes.txt"].filter((p) => p.startsWith(partial)),
  };
  const tab = (text: string, from = sources) => complete(text, text.length, from);
  it("still completes names, listing them with their slash", () => {
    expect(tab("/timel").text).toBe("/timeline ");
    expect(tab("/re").candidates).toContain("/reply");
  });
  it("takes a native command's flags from its usage", () => {
    expect(tab("/thread --u").text).toBe("/thread --undo ");
    expect(tab("/attach a.png --a").text).toBe("/attach a.png --alt ");
  });
  it("asks the CLI for its commands' flags", () => {
    expect(tab("/timeline --j").text).toBe("/timeline --json ");
    expect(tab("/timeline --").candidates).toEqual(["--json", "--limit"]);
  });
  it("completes what /run runs", () => {
    expect(tab("/run tim").text).toBe("/run timeline ");
    expect(tab("/run timeline --j").text).toBe("/run timeline --json ");
  });
  it("completes /attach paths, keeping ~/ and escaping spaces", () => {
    expect(tab("/attach ~/no").text).toBe("/attach ~/notes.txt ");
    expect(tab("/attach ~/My").text).toBe("/attach ~/My\\ Pics");
    expect(tab("/attach a.png ~/no").text).toBe("/attach a.png ~/notes.txt ");
  });
  it("lists paths by name", () => {
    expect(tab("/attach ~/My\\ Pics").candidates).toEqual(["My Pics/", "My Pics.txt"]);
  });
  it("stays in a folder, so Tab can carry on", () => {
    expect(tab("/attach ~/do").text).toBe("/attach ~/docs/");
  });
  it("stays out of an open quote, where it can't tell what the word is", () => {
    const paths = () => ["team.png", "pho.png"];
    for (const text of ['/attach a.png --alt "a te', '/attach "my pho', "/attach 'my pho"]) {
      expect(tab(text, { ...sources, paths })).toEqual({ text, cursor: text.length, candidates: [] });
    }
  });
  it("carries on after a closed one", () => {
    expect(tab('/attach "a b.png" ~/no').text).toBe('/attach "a b.png" ~/notes.txt ');
  });
  it("stays out after a lone backslash", () => {
    const text = "/attach ~/My\\";
    expect(tab(text)).toEqual({ text, cursor: text.length, candidates: [] });
  });
  it("doesn't split an emoji two names begin with", () => {
    const paths = () => ["~/😀a.png", "~/😁b.png"];
    expect(tab("/attach ~/", { ...sources, paths })).toMatchObject({ text: "/attach ~/", candidates: ["😀a.png", "😁b.png"] });
  });
  it("offers recent labels where a ref goes", () => {
    expect(tab("/like ").candidates).toEqual(["3", "2", "A1", "#7", "#6"]);
    expect(tab("/reply A").text).toBe("/reply A1 ");
    expect(tab("/delete #").candidates).toEqual(["#7", "#6"]);
  });
  it("offers eight at most", () => {
    const labels = () => Array.from({ length: 12 }, (_, i) => `#${i + 10}`);
    expect(tab("/like #", { ...sources, labels }).candidates).toHaveLength(8);
  });
  it("leaves the words of a post alone", () => {
    for (const text of ["/reply 3 A", "/post A", "hello w", "/nope x"]) expect(tab(text).text).toBe(text);
  });
  it("needs the cursor at the end", () => {
    expect(complete("/like ", 2, sources)).toEqual({ text: "/like ", cursor: 2, candidates: [] });
  });
});

describe("COMMANDS", () => {
  it("has unique names and aliases that parseInput and Tab completion can both reach", () => {
    const names = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });
});
