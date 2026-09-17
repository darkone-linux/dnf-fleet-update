// Step 2, selection (spec § Étapes): fleet data, `--on`, current zone, wave plan.

import { fail, ok, type Result } from "../../model/result.ts";
import { type GeneratedFile, readGenerated } from "../commands/workspace.ts";
import { ask, emit, log, type RunContext, YES_NO } from "../context.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import { type FleetHost, parseFleet } from "../fleet.ts";
import { parseQuery, selectHosts } from "../query.ts";
import { currentZone, parseProfileList, planWaves } from "../waves.ts";
import { endStep } from "./step.ts";

export interface Selection {
  /** In fleet order. */
  hosts: FleetHost[];

  /** Host names per wave, as planned (event `plan`). */
  waves: string[][];

  /** Zone gateways among the selected hosts: guarded when lost. */
  gateways: ReadonlySet<string>;

  /** The selected host this process runs on: no ssh, no copy, no rollback timer. */
  local?: string;
}

/** `nix-instantiate --json` of a generated file, `unknown` until a schema accepts it. */
export async function readGeneratedJson(
  context: RunContext,
  file: GeneratedFile,
): Promise<Result<unknown>> {
  const spec = readGenerated(context.workspace, file, context.params.timeouts);
  const execution = await execute(context, spec);
  if (!succeeded(execution.result)) return fail(`${file}: ${describeFailure(execution)}`);
  try {
    return ok(JSON.parse(execution.stdout.join("\n")));
  } catch {
    return fail(`${file}: not JSON`);
  }
}

async function choose(context: RunContext): Promise<Selection | undefined> {
  const { params } = context;
  const failed = (error: string) => {
    // Aborted `now`: the run end says it, no failure to report.
    if (!context.signal.aborted) log(context, "error", error);
    return undefined;
  };
  const hostsJson = await readGeneratedJson(context, "hosts.nix");
  if (!hostsJson.ok) return failed(hostsJson.error);
  const networkJson = await readGeneratedJson(context, "network.nix");
  if (!networkJson.ok) return failed(networkJson.error);
  const fleet = parseFleet(hostsJson.value, networkJson.value);
  if (!fleet.ok) return failed(fleet.error);

  let hosts = fleet.value.hosts;
  if (params.on !== undefined) {
    const terms = parseQuery(params.on);
    if (!terms.ok) throw new Error(`unchecked --on: ${terms.error}`);
    const selected = selectHosts(hosts, terms.value);
    for (const term of selected.unmatched) log(context, "warn", `--on: no host matches ${term}`);
    hosts = selected.hosts;
  }
  if (hosts.length === 0) return failed("no host selected");
  for (const host of hosts) {
    emit(context, { kind: "host.add", host: host.name, profile: host.profile, zone: host.zone });
  }

  let zone: string | undefined;
  if (params.currentZoneBefore) {
    zone = currentZone(fleet.value.zones, context.local.addresses());
    if (zone !== undefined) {
      log(context, "info", `current zone: ${zone}`);
    } else {
      log(context, "warn", "current zone not found: waves by profile, all zones together");
      const question = "Current zone not found. Continue with waves by profile?";
      if (params.interactive && (await ask(context, "zone", question, YES_NO)) === "no") {
        context.flow.abort("after-wave");
      }
    }
  }

  const order = parseProfileList(params.deploymentOrder, true);
  if (!order.ok) throw new Error(`unchecked deployment order: ${order.error}`);
  const waves = planWaves({ hosts, order: order.value, currentZone: zone });
  emit(context, { kind: "plan", waves });
  log(context, "ok", `${hosts.length} hosts selected, ${waves.length} waves`);

  const names = new Set(hosts.map((host) => host.name));
  const gateways = fleet.value.zones
    .map((candidate) => candidate.gateway)
    .filter((name): name is string => name !== undefined && names.has(name));
  const hostname = context.local.hostname();
  return {
    hosts,
    waves,
    gateways: new Set(gateways),
    local: names.has(hostname) ? hostname : undefined,
  };
}

/** `undefined`: the run stops (failure reported, or aborted `now`). */
export async function select(context: RunContext): Promise<Selection | undefined> {
  emit(context, { kind: "step.start", step: "select" });
  const selection = await choose(context);
  endStep(context, "select", selection !== undefined);
  return selection;
}
