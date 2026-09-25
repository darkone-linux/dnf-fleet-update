// Run report (spec § Rapport et codes de sortie): short lines for `run.end`,
// markdown for `report.md`. Pure: built from the `state.json` fold.

import type { Analysis } from "../ai/analysis.ts";
import { type SuggestionEntry, suggestionPath } from "../ai/suggestions.ts";
import type { PullSource, RunInfo } from "../model/events.ts";
import type { ExitCode } from "../model/exit-codes.ts";
import { DEFAULTS } from "../model/params.ts";
import type { AiAction, HostStatus, PersistedHost, PersistedState } from "../model/persist.ts";

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

  /** What the AI concluded, per host and for the run (spec § analyse, Rapport). */
  analyses: readonly Analysis[];

  /** Suggestions this run filed or met again (spec § analyse, Suggestions). */
  suggestions?: readonly SuggestionEntry[];

  /** Zones of the run no harmonia serves (spec § Rapport): actionable warning. */
  zonesWithoutCache?: readonly string[];
}

export interface Report {
  lines: string[];

  /** Bullets of the Matrix summary, capitalized: when, options, hosts, ending. */
  facts: string[];

  /** End-of-run synthesis, raw: the room trims it, `report.md` keeps it whole. */
  summary: string[];
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

/**
 * `37 (harmonia ag)`, `44 (harmonia ag 37, cache.nixos.org 7)`, `0`: the total
 * first, then who served it — a zone cache doing its job shows up here.
 */
export function formatPulled(sources: readonly PullSource[]): string {
  const total = sources.reduce((sum, source) => sum + source.paths, 0);
  if (sources.length === 0) return "0";
  const first = sources[0];
  if (sources.length === 1 && first !== undefined) return `${total} (${first.source})`;
  const detail = sources.map((source) => `${source.source} ${source.paths}`).join(", ");
  return `${total} (${detail})`;
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

const incidentLine = (host: PersistedHost) => {
  const units = host.diagnosis?.units ?? [];
  const detail = [
    host.status,
    host.note,
    units.length > 0 ? `units failed: ${units.join(", ")}` : undefined,
  ].filter((part) => part !== undefined);
  return `- ${host.name} (${host.profile}): ${detail.join(", ")}`;
};

/**
 * What the deterministic collection brought back, per host (spec § Erreurs et
 * réparations): failed units, then the error that got the host there.
 */
function diagnostics(hosts: readonly PersistedHost[]): string[] {
  const blocks = hosts.flatMap((host) => {
    const diagnosis = host.diagnosis;
    if (diagnosis === undefined) return [];
    const units = diagnosis.units;
    const excerpt = diagnosis.excerpt ?? [];
    return [
      "",
      `### ${host.name}`,
      ...(units.length > 0 ? ["", `Failed units: ${units.join(", ")}`] : []),
      ...(excerpt.length > 0 ? ["", "```", ...excerpt, "```"] : []),
    ];
  });
  return blocks.length > 0 ? ["", "## Diagnostics", ...blocks] : [];
}

/**
 * What the AI concluded (spec § analyse, Rapport et Matrix): one block per
 * host analysed, then the end-of-run synthesis. Added to the raw reason of a
 * host, never in its place.
 */
function aiAnalysis(analyses: readonly Analysis[]): string[] {
  const blocks = analyses.flatMap((analysis) => [
    "",
    `### ${analysis.host ?? "Run summary"}`,
    "",
    ...analysis.lines,
  ]);
  return blocks.length > 0 ? ["", "## AI analysis", ...blocks] : [];
}

/**
 * What the AI did (spec § réparation, État et rapport): one row per action,
 * refusals included — a repair must be readable after the fact.
 */
function aiRepair(actions: readonly AiAction[]): string[] {
  if (actions.length === 0) return [];
  const rows = actions.map((entry) => [
    entry.host ?? "run",
    entry.action,
    entry.outcome,
    entry.detail ?? "",
  ]);
  return ["", "## AI repair", "", ...table(["Host", "Action", "Outcome", "Why"], rows)];
}

/**
 * What the review filed or met again (spec § analyse, Suggestions), ignored
 * ones left out: the operator silenced them. Not an alert: never in Matrix.
 */
function suggestions(entries: readonly SuggestionEntry[]): string[] {
  const shown = entries.filter((entry) => entry.status !== "ignored");
  if (shown.length === 0) return [];
  const line = (entry: SuggestionEntry) =>
    `- **${entry.title}** — ${entry.fresh ? "new" : `seen in ${entry.runs} runs`} — \`${suggestionPath(entry.slug)}\``;
  return ["", "## Suggestions", "", ...shown.map(line)];
}

/**
 * Hosts a repair commit sent out on new code (spec § réparation, Ce que ça
 * fait au reste du run). Said in the header, so the alert room carries it too:
 * the fleet is split across two revisions until the next run.
 */
function repairedInFlight(actions: readonly AiAction[]): string | undefined {
  const hosts = [
    ...new Set(
      actions.flatMap((entry) =>
        entry.outcome === "done" && entry.action.startsWith("commit ") && entry.host !== undefined
          ? [entry.host]
          : [],
      ),
    ),
  ];
  if (hosts.length === 0) return undefined;
  return `Repaired in flight: ${hosts.join(", ")} — the fleet runs two revisions until the next run`;
}

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
  const { analyses } = input;
  const hosts = state.hosts;
  const ending =
    status === "failed" ? "run stopped on error" : status === "aborted" ? "run aborted" : undefined;
  const lines = [summary(hosts), `duration ${formatDuration(durationMs)}`];
  if (ending) lines.push(ending);

  const run = state.run;
  const started = startedAt(runId);
  const duration = formatDuration(durationMs);
  const repaired = repairedInFlight(state.actions);
  const facts = [
    started === undefined
      ? `Duration: ${duration}`
      : `Started at ${started}, duration: ${duration}`,
    `Options: ${mainOptions(run)}`,
    `Hosts: ${summary(hosts, true)}`,
    ...(repaired === undefined ? [] : [repaired]),
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

  // Who built what: a delegation that did not happen shows up here, and so
  // does a builder that took over after a fallback (spec § Substituteurs).
  const builders = new Map<string, string[]>();
  for (const host of hosts) {
    if (host.builder === undefined) continue;
    builders.set(host.builder, [...(builders.get(host.builder) ?? []), host.name]);
  }
  if (builders.size > 0) {
    const rows = [...builders].map(([builder, names]) => [builder, names.join(", ")]);
    markdown.push("", "## Builders", "", ...table(["Builder", "Hosts built"], rows));
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
            formatPulled(host.copy.pulled),
            String(host.copy.pushed),
            formatBytes(host.copy.pushedBytes),
          ],
        ],
  );
  if (copies.length > 0) {
    const headers = ["Host", "Builder", "Pulled", "Pushed", "Pushed volume"];
    markdown.push("", "## Copies", "", ...table(headers, copies));
  }

  const orphans = input.zonesWithoutCache ?? [];
  if (orphans.length > 0) {
    const line = (zone: string) =>
      `- ${zone}: no harmonia, everything the fleet builds for it travels host by host. Declare one on a host of the zone.`;
    markdown.push("", "## Zones without a cache", "", ...orphans.map(line));
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

  markdown.push(
    ...diagnostics(hosts),
    ...aiAnalysis(analyses),
    ...aiRepair(state.actions),
    ...suggestions(input.suggestions ?? []),
  );

  if (state.notes.length > 0) {
    const line = (note: PersistedState["notes"][number]) =>
      `- ${note.host === undefined ? "" : `${note.host}: `}${note.message}`;
    markdown.push("", "## Notes", "", ...state.notes.map(line));
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
    summary: [...(analyses.find((analysis) => analysis.host === undefined)?.lines ?? [])],
    markdown: `${markdown.join("\n")}\n`,
    ...(incident === undefined ? {} : { incident }),
  };
}
