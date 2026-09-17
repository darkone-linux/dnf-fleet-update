// Parsers of nix output: `nix-eval-jobs` lines and `--log-format internal-json`.
//
// Outside data, one line at a time; a line that does not fit is data too
// (`invalid`, `raw`), never an exception.

import { z } from "zod";

/** A store path of the local store: safe as an argv item and in a remote shell word. */
export const STORE_PATH = /^\/nix\/store\/[0-9a-z]{32}-[a-zA-Z0-9+._?=-]+$/;

const storePath = z.string().regex(STORE_PATH);

const evalOk = z.object({
  attr: z.string(),
  drvPath: storePath.refine((path) => path.endsWith(".drv")),
  outputs: z.object({ out: storePath }),
});

const evalError = z.object({
  attr: z.string(),
  error: z.string(),
  fatal: z.boolean().nullish(),
});

export type EvalJob =
  | { kind: "ok"; host: string; drvPath: string; outPath: string }

  // `fatal`: nix-eval-jobs gave up on the whole evaluation, not just this host.
  | { kind: "error"; host: string; message: string; fatal: boolean }
  | { kind: "invalid"; line: string };

/** Exit code `0` even with errors: the outcome of each host is its line. */
export function parseEvalJob(line: string): EvalJob {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { kind: "invalid", line };
  }

  const error = evalError.safeParse(json);
  if (error.success) {
    return {
      kind: "error",
      host: error.data.attr,
      message: stripAnsi(error.data.error),
      fatal: error.data.fatal === true,
    };
  }
  const job = evalOk.safeParse(json);
  if (job.success) {
    return {
      kind: "ok",
      host: job.data.attr,
      drvPath: job.data.drvPath,
      outPath: job.data.outputs.out,
    };
  }
  return { kind: "invalid", line };
}

/** Cause of a nix error on one line: the last `error:` of its trace, else its first line. */
export function errorSummary(message: string): string {
  const lines = stripAnsi(message)
    .split("\n")
    .map((line) => line.trim());
  const causes = lines.flatMap((line) => /^error:\s*(\S.*)$/.exec(line)?.[1] ?? []);
  return causes.at(-1) ?? lines.find((line) => line !== "")?.replace(/^error:\s*/, "") ?? "";
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

// Activity types (`start`) and result types (`result`) of nix's logger.
const ACTIVITY_COPY_PATH = 100;
const ACTIVITY_BUILD = 105;
const RESULT_BUILD_LOG_LINE = 101;
const RESULT_SET_PHASE = 104;
const RESULT_POST_BUILD_LOG_LINE = 107;

// Verbosity of `msg`.
const LEVEL_ERROR = 0;
const LEVEL_WARN = 1;

export type NixLog =
  /** A build or a substitution starts: `building '…drv'`, `copying path '…' from '…'`. */
  | { kind: "activity"; text: string }
  | { kind: "line"; text: string }
  | { kind: "phase"; phase: string }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string }

  /** Not an internal-json line: plain stderr. */
  | { kind: "raw"; text: string };

const logSchema = z.object({
  action: z.string(),
  type: z.number().nullish(),
  level: z.number().nullish(),
  text: z.string().nullish(),
  msg: z.string().nullish(),
  fields: z.array(z.unknown()).nullish(),
});

const PREFIX = "@nix ";

/**
 * `undefined` for what the tool ignores: progress (tens of thousands of lines
 * per build), expectations, activity ends, chatty messages.
 */
export function parseNixLog(line: string): NixLog | undefined {
  if (!line.startsWith(PREFIX)) {
    return line.trim() === "" ? undefined : { kind: "raw", text: stripAnsi(line) };
  }

  // Fast path: progress results are the bulk of the stream.
  if (line.includes('"action":"result"') && !line.includes(`"type":${RESULT_BUILD_LOG_LINE}`)) {
    if (
      !line.includes(`"type":${RESULT_SET_PHASE}`) &&
      !line.includes(`"type":${RESULT_POST_BUILD_LOG_LINE}`)
    ) {
      return undefined;
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return { kind: "raw", text: line };
  }
  const parsed = logSchema.safeParse(json);
  if (!parsed.success) return { kind: "raw", text: line };
  const { action, type, level, text, msg, fields } = parsed.data;
  const first = typeof fields?.[0] === "string" ? fields[0] : undefined;

  switch (action) {
    case "start":
      if ((type === ACTIVITY_BUILD || type === ACTIVITY_COPY_PATH) && text) {
        return { kind: "activity", text: stripAnsi(text) };
      }
      return undefined;
    case "result":
      if (
        (type === RESULT_BUILD_LOG_LINE || type === RESULT_POST_BUILD_LOG_LINE) &&
        first !== undefined
      ) {
        return { kind: "line", text: stripAnsi(first) };
      }
      if (type === RESULT_SET_PHASE && first !== undefined) return { kind: "phase", phase: first };
      return undefined;
    case "msg":
      if (msg === undefined || msg === null) return undefined;
      if (level === LEVEL_ERROR) return { kind: "error", message: stripAnsi(msg) };
      if (level === LEVEL_WARN) return { kind: "warning", message: stripAnsi(msg) };
      return undefined;
    default:
      return undefined;
  }
}
