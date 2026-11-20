/** A `(Y/n)` answer: anything starting with "n" in any case ("n", "no", "nope") is no, and anything else takes the default, yes. */
export function saidNo(answer: string): boolean {
  return /^n/i.test(answer.trim());
}
