// A password can follow a login in any form, an unclosed quote included, which
// tokenize would throw on. Too wide is safe: such a line is hidden and refused.
const LOGIN = /^\s*\/(login|run\b[\s\S]*?\blogin)\b/i;

/** Whether a line is `/login` or `/run … login`, read without tokenizing it. */
export const isLogin = (input: string) => LOGIN.test(input);

const segmenter = new Intl.Segmenter();

/**
 * A submitted line as it stays in the scrollback: after the prompt it was typed
 * at, with later lines indented as the composer indents them. What follows a
 * login is left out.
 */
export function echoLine(prompt: string, input: string): string {
  if (input.trim() === "") return prompt;
  const login = LOGIN.exec(input);
  const shown = login ? (login[1].toLowerCase() === "login" ? "/login …" : "/run login …") : input;
  const indent = " ".repeat([...segmenter.segment(prompt)].length + 1);
  return `${prompt} ${shown.replaceAll("\n", `\n${indent}`)}`;
}
