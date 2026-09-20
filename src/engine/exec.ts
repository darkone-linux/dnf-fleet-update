// Commands of the steps: output kept, run log fed, failures described.

import { shellJoin } from "./commands/shell.ts";
import { log, type RunContext } from "./context.ts";
import { type KnownError, RETRY_ATTEMPTS } from "./known-errors.ts";
import type { CommandResult, CommandSpec, LogName, OutputLine } from "./ports.ts";

export interface Execution {
  result: CommandResult;
  stdout: string[];
  stderr: string[];

  /** Trap recognised in the output of a failure (spec § Erreurs et réparations). */
  known?: KnownError;
}

export interface ExecOptions {
  /** Receives `$ <command>`, then every output line. */
  log?: LogName;

  /** Default: `now` of the run. `null`: runs even after an abort, bounded by its timeout. */
  signal?: AbortSignal | null;
  onLine?: (line: OutputLine) => void;

  /** Replayable command: a trap asking for a retry is obeyed here. */
  retryable?: boolean;
}

export async function execute(
  context: RunContext,
  spec: CommandSpec,
  options: ExecOptions = {},
): Promise<Execution> {
  let execution = await runOnce(context, spec, options);
  if (!options.retryable) return execution;

  // Transient trap: the same command again, its own bound (spec § Erreurs et
  // réparations). Attempt 1 has already run.
  const fix = execution.known?.fix;
  if (fix?.kind !== "retry") return execution;
  const attempts = fix.max ?? RETRY_ATTEMPTS;
  for (let attempt = 2; attempt <= attempts && !context.signal.aborted; attempt += 1) {
    log(context, "warn", `${execution.known?.message ?? "known error"}, retrying`);
    execution = await runOnce(context, spec, options);
    if (succeeded(execution.result) || execution.known?.fix.kind !== "retry") break;
  }
  return execution;
}

async function runOnce(
  context: RunContext,
  spec: CommandSpec,
  options: ExecOptions,
): Promise<Execution> {
  const { log: logName, onLine } = options;
  const stdout: string[] = [];
  const stderr: string[] = [];
  if (logName) context.run.appendLog(logName, `$ ${shellJoin(spec.argv)}`);

  const result = await context.commands.run(spec, {
    signal: options.signal === null ? undefined : (options.signal ?? context.signal),
    onLine: (line) => {
      (line.stream === "stdout" ? stdout : stderr).push(line.line);
      if (logName) context.run.appendLog(logName, line.line);
      onLine?.(line);
    },
  });
  if (succeeded(result)) return { result, stdout, stderr };

  // Known trap behind a failure: said in plain language, the reason untouched.
  const known = context.known.match([...stderr, ...stdout].join("\n"));

  // Said once per run: the same trap fires on every command it breaks.
  if (known !== undefined && context.known.add(known.message)) {
    log(context, "warn", `hint: ${known.message}`);
  }
  return { result, stdout, stderr, ...(known === undefined ? {} : { known }) };
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

/** A failed command as a step reports it (spec § Erreurs et réparations). */
export interface Failure {
  /** One line: the reason of the host. */
  note: string;

  /** Error lines of the output, for the diagnosis; trimmed by the collection. */
  excerpt?: string[];

  /** Recognised trap: its action is applied instead of a question. */
  known?: KnownError;
}

/** The failure of one command, as the steps pass it around. */
export function failureOf(execution: Execution, note: string): Failure {
  const known = execution.known;
  return { note, excerpt: errorLines(execution), ...(known === undefined ? {} : { known }) };
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
