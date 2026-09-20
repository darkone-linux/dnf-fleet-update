// Known errors (spec § Erreurs et réparations): signature of a failed command
// → what it means in plain language, and what the run may do about it. Pure;
// the raw reason is never replaced.

/** Attempts of a retried command, unless its signature says otherwise. */
export const RETRY_ATTEMPTS = 3;

/**
 * Deterministic answer to a known trap. Declared here, obeyed by the steps
 * that come with the collection and the repair (spec § Erreurs et réparations).
 *
 * - `retry`: transient, `max` attempts in all;
 * - `exclude`: the host alone is lost, the run goes on without it;
 * - `stop`: nothing will work until a human acts;
 * - `ai`: handed over according to `--ai-error-action`;
 * - `none`: explained, nothing deterministic to do.
 */
export type Fix =
  | { kind: "retry"; max?: number }
  | { kind: "exclude" }
  | { kind: "stop" }
  | { kind: "ai" }
  | { kind: "none" };

/** What a matched signature says: the plain message, and the answer to it. */
export interface KnownError {
  message: string;
  fix: Fix;
}

export interface Signature extends KnownError {
  /** Searched in the whole output of the command, stderr first. */
  match: RegExp;
}

const SIGNATURES: readonly Signature[] = [
  {
    // nix-eval-jobs links libnixexpr: another minor hashes a repository
    // holding a git submodule differently, and every host fails to evaluate.
    match: /mismatch in field 'narHash'/,
    message:
      "nix-eval-jobs is not linked against the same Nix as the system: install the version matching nix --version",

    // Same tool evaluates every host: nothing is left to go on with.
    fix: { kind: "stop" },
  },
  {
    // `--no-check-sigs` is honoured for a trusted user only: elsewhere the
    // host refuses every path built here, all of them unsigned.
    match: /lacks a signature by a trusted key/,
    message:
      "the deploy user is not trusted on that host: add nix to its nix.settings.trusted-users",

    // Retrying pushes the same unsigned paths; the host needs a rebuild first.
    fix: { kind: "stop" },
  },
];

/** The first signature found; `undefined` when none matches. */
export function knownError(
  output: string,
  signatures: readonly Signature[] = SIGNATURES,
): KnownError | undefined {
  const found = signatures.find((signature) => signature.match.test(output));
  return found && { message: found.message, fix: found.fix };
}

/**
 * Table of a run, and what it already said: the same trap fires on every
 * command it breaks, and is explained once. Consumer-declared signatures will
 * extend the table here (spec § Erreurs et réparations).
 */
export class KnownErrors {
  private readonly seen = new Set<string>();

  constructor(private readonly signatures: readonly Signature[] = SIGNATURES) {}

  match(output: string): KnownError | undefined {
    return knownError(output, this.signatures);
  }

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
