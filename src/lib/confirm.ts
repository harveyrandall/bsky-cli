/** A `(Y/n)` answer: "n" or "no" in any case is no, and anything else takes the default, yes. */
export function saidNo(answer: string): boolean {
  return /^no?$/i.test(answer.trim());
}
