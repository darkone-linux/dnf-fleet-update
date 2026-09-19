// Run report (spec § Rapport et codes de sortie): short lines for `run.end`,
// markdown for `report.md`. Pure: built from the `state.json` fold.

import type { RunInfo } from "../model/events.ts";
import type { ExitCode } from "../model/exit-codes.ts";
import { DEFAULTS } from "../model/params.ts";
import type { HostStatus, PersistedHost, PersistedState } from "../model/persist.ts";

export interface ReportInput {
  /** `20260917T020000Z-full`: also the only wall clock of the report. */
  runId: string;
  state: PersistedState;
  status: "done" | "failed" | "aborted";
  exitCode: ExitCode;

  /** `t` of the end of the run. */
  durationMs: number;

  /** Evaluation warnings, deduplicated. */
  warnings: readonly string[];

  /** Known errors met, in plain language (spec § Erreurs et réparations). */
  knownErrors: readonly string[];
}

export interface Report {
  lines: string[];

  /** Bullets of the Matrix summary, capitalized: when, options, hosts, ending. */
  facts: string[];
  markdown: string;

  /** Incidents room message (spec § Rapport); absent when nothing needs one. */
  incident?: string;
}

/** First word only, and only a plain word: `nix-eval-jobs …` is a name, not a sentence. */
export const capitalize = (text: string) =>
  /^[a-z]+(\s|$)/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/**
 * `20260917T020000Z-full` → `2026-09-17 02:00:00 UTC`. Read from the run id:
 * `Clock` is monotonic, the engine has no wall clock of its own.
 */
export function startedAt(runId: string): string | undefined {
  const stamp = /^\d{8}T\d{6}Z/.exec(runId)?.[0];
  if (stamp === undefined) return undefined;
  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const time = `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  return `${date} ${time} UTC`;
}

/** Options that explain what the run did, and nothing else: one line. */
export function mainOptions(run: RunInfo | undefined): string {
  if (run === undefined) return "unknown";
  const params = run.params;
  const parts = [`${run.mode} run`, `selection ${run.selection}`];
  if (params?.buildOnly) parts.push("build only");
  if (params?.skipTest) parts.push("test skipped");
  if (params?.skipSwitch) parts.push("switch skipped");
  if (params?.stopLoss) parts.push("stop loss");
  if (params?.rollbackTimeout === 0) parts.push("no automatic rollback");
  parts.push(`${run.maxParallel} in parallel`);
  return parts.join(", ");
}

/** `27s`, `3m05s`, `1h02m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** `648 MiB`, `1.2 MiB`, `12 KiB`: a figure to read, not an exact size. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, Math.round(bytes));
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${UNITS[unit] ?? "B"}`;
}

/** Summary order: what worked, then what needs a look. */
const STATUSES: readonly { status: HostStatus; label: string; named: boolean }[] = [
  { status: "deployed", label: "deployed", named: false },
  { status: "tested", label: "left in test", named: true },
  { status: "error", label: "with failed units", named: true },
  { status: "failed", label: "failed", named: true },
  { status: "reverted", label: "rolled back", named: true },
  { status: "offline", label: "offline", named: true },
  { status: "excluded", label: "excluded", named: true },
  { status: "remaining", label: "not done", named: true },
];

/** `nameAll`: the report names every host, the feed only those needing a look. */
function summary(hosts: readonly PersistedHost[], nameAll = false): string {
  const parts = STATUSES.flatMap(({ status, label, named }) => {
    const matching = hosts.filter((host) => host.status === status);
    if (matching.length === 0) return [];
    const names = named || nameAll ? ` (${matching.map((host) => host.name).join(", ")})` : "";
    return [`${matching.length} ${label}${names}`];
  });
  return parts.length > 0 ? parts.join(", ") : "no host";
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function table(headers: readonly string[], rows: readonly string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

/** Host out of the new generation, whatever the run did: worth a separate message. */
const INCIDENT_STATUSES: readonly HostStatus[] = [
  "offline",
  "excluded",
  "failed",
  "error",
  "reverted",
];

const incidentLine = (host: PersistedHost) =>
  `- ${host.name} (${host.profile}): ${host.status}${host.note === undefined ? "" : `, ${host.note}`}`;

/**
 * Message of the incidents room (spec § Rapport): critical hosts the run left
 * out, and, after a stop, hosts left in `test` — a reboot takes those back to
 * their previous generation. `undefined`: nothing to raise.
 */
function incidentMessage(state: PersistedState, status: ReportInput["status"]): string | undefined {
  const declared = state.run?.params?.criticalProfiles ?? DEFAULTS.criticalProfiles;
  const critical = new Set(declared.split(":"));
  const concerned = state.hosts.filter(
    (host) => critical.has(host.profile) && INCIDENT_STATUSES.includes(host.status),
  );

  // A completed run leaves hosts in `test` only when asked to (`--skip-switch`).
  const inTest =
    status === "done"
      ? []
      : state.hosts.filter((host) => host.status === "tested" || host.status === "error");
  if (concerned.length === 0 && inTest.length === 0) return undefined;

  const parts: string[] = [];
  if (concerned.length > 0) {
    parts.push("## Critical hosts not deployed", "", ...concerned.map(incidentLine));
  }
  if (inTest.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("## Hosts left in test", "", ...inTest.map((host) => `- ${host.name}`));
  }
  return `${parts.join("\n")}\n`;
}

export function renderReport(input: ReportInput): Report {
  const { runId, state, status, exitCode, durationMs, warnings, knownErrors } = input;
  const hosts = state.hosts;
  const ending =
    status === "failed" ? "run stopped on error" : status === "aborted" ? "run aborted" : undefined;
  const lines = [summary(hosts), `duration ${formatDuration(durationMs)}`];
  if (ending) lines.push(ending);

  const run = state.run;
  const started = startedAt(runId);
  const duration = formatDuration(durationMs);
  const facts = [
    started === undefined
      ? `Duration: ${duration}`
      : `Started at ${started}, duration: ${duration}`,
    `Options: ${mainOptions(run)}`,
    `Hosts: ${summary(hosts, true)}`,
  ];
  const commits = state.commits.map(
    (commit) =>
      `${commit.repo === "dnf" ? "dnf/" : "consumer"} ${commit.rev.slice(0, 7)} ${commit.message}`,
  );
  const markdown = [
    "# Fleet Update Report",
    "",
    `- Status: ${status} (exit ${exitCode})`,
    ...facts.map((fact) => `- ${fact}`),
    `- Commits: ${commits.length > 0 ? commits.join("; ") : "none"}`,
    "",
    "## Steps",
    "",
    ...table(
      ["Step", "Status", "Duration"],

      // Written during the report step: it cannot time itself.
      Object.entries(state.steps)
        .filter(([step]) => step !== "report")
        .map(([step, { status: stepStatus, startedAt, endedAt }]) => [
          step,
          stepStatus,
          startedAt !== undefined && endedAt !== undefined
            ? formatDuration(endedAt - startedAt)
            : "",
        ]),
    ),
  ];

  if (state.waves.length > 0) {
    const rows = state.waves.map((wave, index) => {
      const next = state.waves[index + 1];
      const end = next?.step === wave.step ? next.startedAt : state.steps[wave.step].endedAt;
      const duration = end === undefined ? "" : formatDuration(end - wave.startedAt);
      return [wave.step, `${wave.index}/${wave.total}`, wave.hosts.join(", "), duration];
    });
    markdown.push("", "## Waves", "", ...table(["Step", "Wave", "Hosts", "Duration"], rows));
  }

  // Where the closure came from, per host: a zone cache doing its job pulls
  // far more than the run pushes (spec § Rapport).
  const copies = hosts.flatMap((host) =>
    host.copy === undefined
      ? []
      : [
          [
            host.name,
            host.copy.builder,
            String(host.copy.pulled),
            String(host.copy.pushed),
            formatBytes(host.copy.pushedBytes),
          ],
        ],
  );
  if (copies.length > 0) {
    const headers = ["Host", "Builder", "Pulled", "Pushed", "Pushed volume"];
    markdown.push("", "## Copies", "", ...table(headers, copies));
  }

  const notDeployed = hosts.filter(
    (host) => host.status !== "deployed" && host.status !== "tested",
  );
  if (notDeployed.length > 0) {
    const rows = notDeployed.map((host) => [host.name, host.status, host.note ?? ""]);
    markdown.push("", "## Hosts not deployed", "", ...table(["Host", "Status", "Reason"], rows));
  }

  const inTest = hosts.filter((host) => host.status === "tested" || host.status === "error");
  if (inTest.length > 0) {
    markdown.push("", "## Hosts left in test", "", ...inTest.map((host) => `- ${host.name}`));
  }

  if (knownErrors.length > 0) {
    markdown.push("", "## Known errors", "", ...knownErrors.map((message) => `- ${message}`));
  }
  if (warnings.length > 0) {
    markdown.push("", "## Evaluation warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  const incident = incidentMessage(state, status);
  return {
    lines,
    facts: ending === undefined ? facts : [...facts, capitalize(ending)],
    markdown: `${markdown.join("\n")}\n`,
    ...(incident === undefined ? {} : { incident }),
  };
}
