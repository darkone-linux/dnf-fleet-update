// Commands of the steps: output kept, run log fed, failures described.

import { shellJoin } from "./commands/shell.ts";
import { log, type RunContext } from "./context.ts";
import { knownError } from "./known-errors.ts";
import type { CommandResult, CommandSpec, LogName, OutputLine } from "./ports.ts";

export interface Execution {
  result: CommandResult;
  stdout: string[];
  stderr: string[];
}

export interface ExecOptions {
  /** Receives `$ <command>`, then every output line. */
  log?: LogName;

  /** Default: `now` of the run. `null`: runs even after an abort, bounded by its timeout. */
  signal?: AbortSignal | null;
  onLine?: (line: OutputLine) => void;
}

export async function execute(
  context: RunContext,
  spec: CommandSpec,
  options: ExecOptions = {},
): Promise<Execution> {
  const { log, onLine } = options;
  const stdout: string[] = [];
  const stderr: string[] = [];
  if (log) context.run.appendLog(log, `$ ${shellJoin(spec.argv)}`);

  const result = await context.commands.run(spec, {
    signal: options.signal === null ? undefined : (options.signal ?? context.signal),
    onLine: (line) => {
      (line.stream === "stdout" ? stdout : stderr).push(line.line);
      if (log) context.run.appendLog(log, line.line);
      onLine?.(line);
    },
  });
  const execution = { result, stdout, stderr };

  // Known trap behind a failure: said in plain language, the reason untouched.
  if (!succeeded(result)) hint(context, execution);
  return execution;
}

function hint(context: RunContext, { stdout, stderr }: Execution): void {
  const known = knownError([...stderr, ...stdout].join("\n"));
  if (known !== undefined && context.known.add(known.message)) {
    log(context, "warn", `hint: ${known.message}`);
  }
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

/** A failed command as a step reports it (spec § Erreurs et réparations). */
export interface Failure {
  /** One line: the reason of the host. */
  note: string;

  /** Error lines of the output, for the diagnosis; trimmed by the collection. */
  excerpt: string[];
}

/** Error lines of a failed command: stderr, or stdout when it said nothing. */
export function errorLines({ stdout, stderr }: Execution): string[] {
  const notEmpty = (line: string) => line.trim() !== "";
  const errors = stderr.filter(notEmpty);
  return errors.length > 0 ? errors : stdout.filter(notEmpty);
}

/** Longest error excerpt kept on one feed line. */
const EXCERPT = 160;

/** Why it failed, on one line: cause, then the last non-empty stderr line. */
export function describeFailure({ result, stderr }: Execution): string {
  const cause = result.timedOut
    ? "timed out"
    : result.exitCode === null
      ? `killed by ${result.signal ?? "a signal"}`
      : `exit ${result.exitCode}`;
  const last = stderr.findLast((line) => line.trim() !== "")?.trim();
  if (last === undefined) return cause;
  return `${cause}: ${last.length > EXCERPT ? `${last.slice(0, EXCERPT)}…` : last}`;
}
