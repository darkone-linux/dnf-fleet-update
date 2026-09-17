// Run report (spec § Rapport et codes de sortie): short lines for `run.end`,
// markdown for `report.md`. Pure: built from the `state.json` fold.

import type { ExitCode } from "../model/exit-codes.ts";
import type { HostStatus, PersistedHost, PersistedState } from "../model/persist.ts";

export interface ReportInput {
  state: PersistedState;
  status: "done" | "failed" | "aborted";
  exitCode: ExitCode;

  /** `t` of the end of the run. */
  durationMs: number;

  /** Evaluation warnings, deduplicated. */
  warnings: readonly string[];
}

export interface Report {
  lines: string[];
  markdown: string;
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

function summary(hosts: readonly PersistedHost[]): string {
  const parts = STATUSES.flatMap(({ status, label, named }) => {
    const matching = hosts.filter((host) => host.status === status);
    if (matching.length === 0) return [];
    const names = named ? ` (${matching.map((host) => host.name).join(", ")})` : "";
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

export function renderReport(input: ReportInput): Report {
  const { state, status, exitCode, durationMs, warnings } = input;
  const hosts = state.hosts;
  const ending =
    status === "failed" ? "run stopped on error" : status === "aborted" ? "run aborted" : undefined;
  const lines = [summary(hosts), `duration ${formatDuration(durationMs)}`];
  if (ending) lines.push(ending);

  const run = state.run;
  const commits = state.commits.map(
    (commit) =>
      `${commit.repo === "dnf" ? "dnf/" : "consumer"} ${commit.rev.slice(0, 7)} ${commit.message}`,
  );
  const markdown = [
    "# fleet-update report",
    "",
    `- Status: ${status} (exit ${exitCode})`,
    `- Mode: ${run?.mode ?? "unknown"}, selection: ${run?.selection ?? "unknown"}`,
    `- Commits: ${commits.length > 0 ? commits.join("; ") : "none"}`,
    `- Duration: ${formatDuration(durationMs)}`,
    `- Hosts: ${summary(hosts)}`,
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

  if (warnings.length > 0) {
    markdown.push("", "## Evaluation warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  return { lines, markdown: `${markdown.join("\n")}\n` };
}
