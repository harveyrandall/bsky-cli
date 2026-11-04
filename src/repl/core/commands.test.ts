import { describe, it, expect } from "vitest";
import { COMMANDS, tokenize, suggest, completeCommand } from "./commands";

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
    expect(completeCommand("/e", 2)).toEqual({ text: "/exit ", cursor: 6, candidates: [] });
  });
  it("lists candidates when it can't extend", () => {
    expect(completeCommand("/re", 3)).toEqual({ text: "/re", cursor: 3, candidates: ["reply", "reply-from", "retry"] });
    expect(completeCommand("/rep", 4)).toEqual({ text: "/reply", cursor: 6, candidates: [] });
    expect(completeCommand("/reply", 6)).toEqual({ text: "/reply", cursor: 6, candidates: ["reply", "reply-from"] });
  });
  it("leaves other text alone", () => {
    expect(completeCommand("/x", 2)).toEqual({ text: "/x", cursor: 2, candidates: [] });
    expect(completeCommand("hello", 5)).toEqual({ text: "hello", cursor: 5, candidates: [] });
    expect(completeCommand("/help ex", 8)).toEqual({ text: "/help ex", cursor: 8, candidates: [] });
  });
});

describe("COMMANDS", () => {
  it("has unique names and aliases that parseInput and Tab completion can both reach", () => {
    const names = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });
});
