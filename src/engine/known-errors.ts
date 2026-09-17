// Known errors (spec § Erreurs et réparations): signature of a failed command
// → what it means, in plain language. Pure; the raw reason is never replaced.

interface Signature {
  /** Searched in the whole output of the command, stderr first. */
  match: RegExp;
  message: string;
}

const SIGNATURES: readonly Signature[] = [
  {
    // nix-eval-jobs links libnixexpr: another minor hashes a repository
    // holding a git submodule differently, and every host fails to evaluate.
    match: /mismatch in field 'narHash'/,
    message:
      "nix-eval-jobs is not linked against the same Nix as the system: install the version matching nix --version",
  },
];

/** Plain message of the first signature found; `undefined` when none matches. */
export function knownError(output: string): string | undefined {
  return SIGNATURES.find((signature) => signature.match.test(output))?.message;
}

/** Said once per run: the same trap fires on every command it breaks. */
export class KnownErrors {
  private readonly seen = new Set<string>();

  /** `true` the first time this message is seen. */
  add(message: string): boolean {
    if (this.seen.has(message)) return false;
    this.seen.add(message);
    return true;
  }

  all(): string[] {
    return [...this.seen];
  }
}
