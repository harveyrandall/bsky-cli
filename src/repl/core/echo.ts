// A password can follow a login in any form, an unclosed quote included, which
// tokenize would throw on. Leaving out too much is safe.
const LOGIN = /^\s*\/(login|run\b[\s\S]*?\blogin)\b/i;

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
