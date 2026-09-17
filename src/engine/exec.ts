// Commands of the steps: output kept, run log fed, failures described.

import { shellJoin } from "./commands/shell.ts";
import type { RunContext } from "./context.ts";
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
  return { result, stdout, stderr };
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
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
