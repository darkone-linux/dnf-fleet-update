// Panels of the main screen. Presentation only: everything comes from RunState.

import { useEffect, useState } from "react";
import { STEPS, STEP_LABELS, type HostState } from "../model/events.ts";
import {
  activeHosts,
  excludedCount,
  visibleHosts,
  type FeedItem,
  type HostRow,
  type RunState,
} from "../model/state.ts";
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  clock,
  color,
  hostGlyph,
  hostStateColor,
  levelColor,
  progressBar,
  serviceFailureGlyph,
  stepColor,
  stepGlyph,
} from "../model/theme.ts";

/** Single ticker: one interval for every spinner on screen. */
export function useSpinner(): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "✳";
}

function glyphOf(host: HostRow, spinner: string): string {
  if (hostGlyph[host.state] === "") return spinner;
  if (host.state === "failed" && host.failure === "service") return serviceFailureGlyph;
  return hostGlyph[host.state];
}

const ACTIVE_LABEL: Partial<Record<HostState, string>> = {
  building: "building",
  copying: "copying",
  testing: "testing",
  switching: "switching",
};

// -----------------------------------------------------------------------------
// FEED
// -----------------------------------------------------------------------------

function FeedLine({ item, expanded }: { item: FeedItem; expanded: boolean }) {
  if (item.kind === "ai") {
    const detail = item.detail ?? [];
    const shown = expanded ? detail : detail.slice(0, 3);
    return (
      <box flexDirection="column" border={["left"]} borderColor={color.ai} paddingLeft={1}>
        <text>
          <span fg={color.ai}>AI→ </span>
          <span fg={color.text}>{item.message}</span>
        </text>
        {shown.map((line, index) => (
          <text key={index} fg={color.dim}>
            {line}
          </text>
        ))}
        {detail.length > 3 && !expanded ? (
          <text fg={color.dim}>{`⏵ ${detail.length - 3} more lines (↵)`}</text>
        ) : null}
      </box>
    );
  }

  return (
    <text>
      <span fg={color.dim}>{clock(item.t)} </span>
      {item.host ? <span fg={color.host}>{`[ ${item.host} ] `}</span> : null}
      <span fg={levelColor[item.level]}>{item.message}</span>
    </text>
  );
}

export function Feed({
  state,
  focused,
  expanded,
}: {
  state: RunState;
  focused: boolean;
  expanded: Set<number>;
}) {
  return (
    <scrollbox
      flexGrow={1}
      focused={focused}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
      border={["right"]}
      borderColor={focused ? color.activeBorder : color.border}
      scrollbarOptions={{ visible: false }}
    >
      {state.feed.map((item) => (
        <FeedLine key={item.id} item={item} expanded={expanded.has(item.id)} />
      ))}
    </scrollbox>
  );
}

// -----------------------------------------------------------------------------
// ACTIVE REGION
// -----------------------------------------------------------------------------

/** Bounded: step 4 builds every host at once, and the region must not eat the feed. */
const ACTIVE_MAX_ROWS = 8;

export function Active({ state, spinner }: { state: RunState; spinner: string }) {
  const hosts = activeHosts(state);
  if (hosts.length === 0) return null;
  const shown = hosts.slice(0, ACTIVE_MAX_ROWS);

  return (
    <box
      flexDirection="column"
      border={["top", "right"]}
      borderColor={color.border}
      title=" active "
      paddingLeft={1}
      paddingRight={1}
    >
      {shown.map((host) => (
        <box key={host.name} flexDirection="row">
          <text fg={color.warn}>{`${spinner} `}</text>
          <text fg={color.host}>{host.name.padEnd(9)}</text>
          <text fg={color.dim}>{(host.phase ?? "").padEnd(10)}</text>
          <text fg={color.dim}>{host.lastLine ?? ""}</text>
        </box>
      ))}
      {hosts.length > shown.length ? (
        <text fg={color.dim}>{`+${hosts.length - shown.length} more`}</text>
      ) : null}
    </box>
  );
}

// -----------------------------------------------------------------------------
// SIDEBAR
// -----------------------------------------------------------------------------

function StepRows({ state, spinner }: { state: RunState; spinner: string }) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {STEPS.map((step, index) => {
        const row = state.steps[step];
        const running = row.status === "running";
        const glyph = stepGlyph[row.status] === "" ? spinner : stepGlyph[row.status];
        const counter = row.total > 0 ? `${row.done}/${row.total}` : "";
        return (
          <box key={step} flexDirection="row" backgroundColor={running ? color.highlight : undefined}>
            <text fg={stepColor[row.status]}>{`${glyph} `}</text>
            <text fg={running ? color.text : stepColor[row.status]}>
              {`${index + 1} ${STEP_LABELS[step]}`}
            </text>
            <box flexGrow={1} />
            {counter ? <text fg={color.dim}>{`${progressBar(row.done, row.total)} ${counter}`}</text> : null}
          </box>
        );
      })}
    </box>
  );
}

function HostRows({
  state,
  spinner,
  selected,
  focused,
}: {
  state: RunState;
  spinner: string;
  selected: number;
  focused: boolean;
}) {
  const hosts = visibleHosts(state);
  const excluded = excludedCount(state);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border={["top"]}
      borderColor={color.border}
      title={` hosts (${hosts.length}${excluded > 0 ? `, ${excluded} excluded` : ""}) `}
      paddingLeft={1}
      paddingRight={1}
    >
      {hosts.map((host, index) => {
        const current = focused && index === selected;
        const label = ACTIVE_LABEL[host.state] ?? host.state;
        return (
          <box
            key={host.name}
            flexDirection="row"
            backgroundColor={current ? color.highlight : undefined}
          >
            <text>{`${glyphOf(host, spinner)} `}</text>
            <text fg={current ? color.text : color.host}>{host.name}</text>
            <box flexGrow={1} />
            <text fg={hostStateColor[host.state]}>{label}</text>
          </box>
        );
      })}
    </box>
  );
}

export function Sidebar({
  state,
  spinner,
  selected,
  focused,
}: {
  state: RunState;
  spinner: string;
  selected: number;
  focused: boolean;
}) {
  const version = state.run?.version ?? "0.0.0";
  return (
    <box
      flexDirection="column"
      width={36}
      border={["left"]}
      borderColor={focused ? color.activeBorder : color.border}
      title={` DNF Fleet Updater v${version} `}
    >
      <StepRows state={state} spinner={spinner} />
      <HostRows state={state} spinner={spinner} selected={selected} focused={focused} />
    </box>
  );
}

// -----------------------------------------------------------------------------
// FOOTER
// -----------------------------------------------------------------------------

export function StatusBar({ state }: { state: RunState }) {
  const run = state.run;
  if (!run) return <text fg={color.dim}> starting…</text>;

  const parts = [
    run.mode,
    run.codev ? "codev" : null,
    run.aiModel,
    `${state.hosts.length} hosts`,
    `x${run.maxParallel}`,
    run.selection,
  ].filter((part): part is string => Boolean(part));

  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg={color.dim}>{parts.join(" · ")}</text>
      <box flexGrow={1} />
      {state.end ? (
        <text fg={state.end.exitCode === 0 ? color.ok : color.error}>
          {`${state.end.status} (${state.end.exitCode})`}
        </text>
      ) : null}
    </box>
  );
}

export function Keys({ view }: { view: string }) {
  const keys =
    view === "logs"
      ? "q back  ↑↓ scroll"
      : "q quit  ⇥ focus  ↵ logs  a ai  ^c abort  ? help";
  return (
    <box paddingLeft={1} paddingRight={1}>
      <text fg={color.dim}>{keys}</text>
    </box>
  );
}
