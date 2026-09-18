// `--resume` (spec § État et reprise): reading what the last run left, and
// deciding what of it a new run picks up.
//
// `state.json` is outside data, even though we wrote it: validated here, never
// trusted on its shape.

import { z } from "zod";
import { AI_ANALYSIS, AI_ERROR_ACTION, type RunParams } from "../model/params.ts";
import { type HostStatus, PERSIST_SCHEMA } from "../model/persist.ts";
import { fail, ok, type Result } from "../model/result.ts";
import { STORE_PATH } from "./nix-output.ts";

/**
 * Statuses a resume takes back: work left, not decisions taken. `deployed` is
 * done; `excluded` and `reverted` were decided during the run; `error` waits
 * for its units (spec § Erreurs et réparations).
 */
const RESUMABLE = ["remaining", "offline", "failed", "tested"] as const satisfies HostStatus[];

const resumable: ReadonlySet<string> = new Set<string>(RESUMABLE);

const seconds = z.number().int().nonnegative();

/** Flags of the invocation, absent from a `state.json` written by an older tool. */
const flag = z.boolean().default(false);

const savedParams = z.object({
  on: z.string().optional(),
  deploymentOrder: z.string(),
  criticalProfiles: z.string(),
  currentZoneBefore: z.boolean(),
  dnfFlake: z.boolean(),
  consumerFlake: z.boolean(),
  dnfMessage: z.string(),
  consumerMessage: z.string(),
  buildOnly: flag,
  skipTest: flag,
  skipSwitch: flag,
  resume: flag,
  interactive: z.boolean(),
  stopLoss: flag,
  ui: z.boolean(),
  sendReport: flag,
  aiModel: z.string(),
  aiAnalysis: z.enum(AI_ANALYSIS),
  aiErrorAction: z.enum(AI_ERROR_ACTION),
  maxParallel: z.number().int().positive(),
  rollbackTimeout: seconds,
  timeouts: z.object({
    flakeUpdate: seconds,
    clean: seconds,
    commit: seconds,
    eval: seconds,
    build: seconds,
    copy: seconds,
    activation: seconds,
    ssh: seconds,
    ping: seconds,
    matrix: seconds,
    killGrace: seconds,
  }),
  pingInterval: z.number().int().positive(),
}) satisfies z.ZodType<RunParams, unknown>;

const savedHost = z.object({
  name: z.string(),
  status: z.string(),
  path: z.string().regex(STORE_PATH).optional(),
  origin: z.object({ system: z.string(), profile: z.string() }).optional(),
});

const savedState = z.object({
  schema: z.literal(PERSIST_SCHEMA),
  run: z.object({ params: savedParams.optional() }).optional(),
  revisions: z.object({ dnf: z.string().optional(), consumer: z.string().optional() }).default({}),
  plan: z.array(z.array(z.string())).default([]),
  hosts: z.array(savedHost).default([]),
});

export type SavedHost = z.infer<typeof savedHost>;

export interface SavedState {
  /** Directory of the saved run, `<date>-<mode>`: named in the feed. */
  id: string;

  params: RunParams;

  /** Revisions the saved run built from; a path is reused only if they still hold. */
  revisions: { dnf?: string; consumer?: string };

  /** Wave plan of the saved run: a resume keeps its order. */
  plan: string[][];

  /** Hosts a resume takes back, in the order the saved run held them. */
  hosts: SavedHost[];
}

/** `error`: what to tell the operator, exit `2`; no run directory is created. */
export function parseSavedState(id: string, text: string): Result<SavedState> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("state.json: not JSON");
  }
  const parsed = savedState.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    return fail(`state.json: ${issue?.message ?? "invalid"}${where === "" ? "" : ` (${where})`}`);
  }
  const { run, revisions, plan, hosts } = parsed.data;
  if (run?.params === undefined) return fail("state.json: no run parameters to resume from");

  return ok({
    id,
    params: run.params,
    revisions,
    plan,
    hosts: hosts.filter((host) => resumable.has(host.status)),
  });
}

/**
 * Same trees as the saved run: only then does a path it built still describe
 * the configuration of today. Unknown revision (older state, or HEAD unread):
 * no reuse.
 */
export function sameRevisions(
  saved: SavedState["revisions"],
  current: SavedState["revisions"],
  codev: boolean,
): boolean {
  if (saved.consumer === undefined || saved.consumer !== current.consumer) return false;
  if (!codev) return true;
  return saved.dnf !== undefined && saved.dnf === current.dnf;
}

/** Progress a resumed host starts from, once its path is known to be reusable. */
export type Restored = { state: "built" | "tested"; path: string; origin?: SavedHost["origin"] };

/**
 * What the new run rehydrates for one host. Without a reusable path the host
 * starts over: its `tested` stood for a store path that is no longer the one
 * to deploy.
 */
export function restore(host: SavedHost, reusable: boolean): Restored | undefined {
  if (!reusable || host.path === undefined) return undefined;
  const state = host.status === "tested" ? "tested" : "built";
  return { state, path: host.path, ...(host.origin === undefined ? {} : { origin: host.origin }) };
}
