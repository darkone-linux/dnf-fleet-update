// Process exit codes (spec § Rapport et codes de sortie).
//
// Contract, not detail: `run.end` carries one, and the systemd module maps
// `Locked` to `SuccessExitStatus` so a concurrent run raises no alert.

export const ExitCode = {
  Ok: 0,

  /** Wins over every other code, report sent or not. */
  Failed: 1,
  InvalidOptions: 2,

  /** Run finished, Matrix report not delivered. */
  ReportNotSent: 3,
  Locked: 4,
  Aborted: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
