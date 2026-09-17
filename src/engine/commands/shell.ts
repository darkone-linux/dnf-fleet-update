// POSIX shell quoting: `ssh` joins its argv into one string for the remote shell.

const SAFE = /^[a-zA-Z0-9_@%+=:,./-]+$/;

/** One shell word, single-quoted unless every character is inert. */
export function shellQuote(word: string): string {
  return SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
