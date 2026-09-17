// Real `DeploymentStore`: run directories under `var/deployments/` (spec § État et reprise).

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DeploymentStore,
  type LogName,
  logFileName,
  RUN_FILE_NAME,
  type RunStore,
} from "../engine/ports.ts";
import type { Event, RunInfo } from "../model/events.ts";
import type { PersistedState } from "../model/persist.ts";

/** ISO 8601 basic, UTC: names sort by date across DST changes, and fit unit names. */
export function runDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

class RunDirectory implements RunStore {
  constructor(
    readonly id: string,
    private readonly dir: string,
  ) {}

  appendEvent(event: Event): void {
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  writeState(state: PersistedState): void {
    const target = join(this.dir, "state.json");
    writeFileSync(`${target}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }

  appendLog(name: LogName, line: string): void {
    appendFileSync(join(this.dir, "logs", `${logFileName(name)}.log`), `${line}\n`);
  }

  writeReport(markdown: string): void {
    writeFileSync(join(this.dir, "report.md"), markdown);
  }

  outLink(host: string): string {
    if (!RUN_FILE_NAME.test(host)) throw new Error(`unsafe host: ${JSON.stringify(host)}`);
    return join(this.dir, "gcroots", host);
  }
}

export class DirectoryStore implements DeploymentStore {
  /** `root`: `<workspace>/var/deployments`. */
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(mode: RunInfo["mode"]): RunStore {
    const id = `${runDate(this.now())}-${mode}`;
    const dir = join(this.root, id);
    mkdirSync(this.root, { recursive: true });

    // Not recursive: an existing run directory throws.
    mkdirSync(dir);
    mkdirSync(join(dir, "logs"));
    mkdirSync(join(dir, "gcroots"));
    return new RunDirectory(id, dir);
  }
}
