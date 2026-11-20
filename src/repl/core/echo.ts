import { tokenize } from "./commands";

// The CLI's options that take the next word: -p work, --profile work, -c path,
// --config path, and -vp work. -pwork and --profile=work hold their own value.
const takesValue = (option: string) => (option.startsWith("--") ? option === "--profile" || option === "--config" : /^-[^pc]*[pc]$/.test(option));

/** The command a `/run` line runs: what follows the CLI's leading options. Any other option counts as a flag. */
function command(tokens: readonly string[]): string | undefined {
  let i = 0;
  while (tokens[i]?.startsWith("-") && tokens[i] !== "--") i += takesValue(tokens[i]) ? 2 : 1;
  return tokens[i] === "--" ? tokens[i + 1] : tokens[i];
}

// A password can follow in any form, an unclosed quote included, which tokenize throws on.
// Then the raw text is read the same way: options, then login as the next word.
const UNCLOSED_LOGIN = /^(?:\s+(?:-[a-z]*[pc]|--profile|--config)\s+(?:"[^"]*"|'[^']*'|\S)+|\s+-\S*)*\s+["']?login\b/i;

function runsLogin(rest: string): boolean {
  try {
    return command(tokenize(rest))?.toLowerCase() === "login";
  } catch {
    return UNCLOSED_LOGIN.test(rest);
  }
}

/** How a login is shown, or undefined for any other line. */
function login(input: string): string | undefined {
  const match = /^\s*\/(login|run)\b([\s\S]*)$/i.exec(input);
  if (!match) return undefined;
  if (match[1].toLowerCase() === "login") return "/login …";
  return runsLogin(match[2]) ? "/run login …" : undefined;
}

/** Whether a line is `/login`, or `/run` with login as its command, read before dispatch can throw on it. */
export const isLogin = (input: string) => login(input) !== undefined;

const segmenter = new Intl.Segmenter();

/**
 * A submitted line as it stays in the scrollback: after the prompt it was typed
 * at, with later lines indented as the composer indents them. A login is shown
 * only as `/login …` or `/run login …`.
 */
export function echoLine(prompt: string, input: string): string {
  if (input.trim() === "") return prompt;
  const shown = login(input) ?? input;
  const indent = " ".repeat([...segmenter.segment(prompt)].length + 1);
  return `${prompt} ${shown.replaceAll("\n", `\n${indent}`)}`;
}
