// Panels of the main screen. Presentation only: everything comes from RunState.

import { useEffect, useState, type ReactNode } from "react";
import { STEP_LABELS, STEPS, type HostState } from "../model/events.ts";
import {
  activeHosts,
  excludedCount,
  visibleHosts,
  type FeedItem,
  type HostRow,
  type RunState,
} from "../model/state.ts";
import {
  HOST_SPINNER,
  SPINNER_INTERVAL_MS,
  STEP_SPINNER,
  clock,
  color,
  hostGlyph,
  hostStateColor,
  levelColor,
  padGlyph,
  progressBar,
  serviceFailureGlyph,
  stepColor,
  stepGlyph,
} from "../model/theme.ts";

/** Single ticker: one interval drives every spinner on screen. */
export function useSpinners(): { step: string; host: string } {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return {
    step: STEP_SPINNER[frame % STEP_SPINNER.length] ?? "⠋",
    host: HOST_SPINNER[frame % HOST_SPINNER.length] ?? "✳",
  };
}

function hostCell(host: HostRow, spinner: string): string {
  if (hostGlyph[host.state] === "") return padGlyph(spinner, false);
  if (host.state === "failed" && host.failure === "service") return serviceFailureGlyph;
  return hostGlyph[host.state];
}

const ACTIVE_LABEL: Partial<Record<HostState, string>> = {
  building: "building",
  copying: "copying",
  testing: "testing",
  switching: "switching",
};

/**
 * Grey callout with a thin accent rule on the left. Shared by the active
 * region, the AI answers, the questions and the help.
 */
export function AccentBlock({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      marginLeft={2}
      marginRight={2}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={color.block}
      border={["left"]}
      borderStyle="single"
      borderColor={accent}
    >
      {children}
    </box>
  );
}

// -----------------------------------------------------------------------------
// FEED
// -----------------------------------------------------------------------------

/** Rolling window while the answer streams; collapsed height once it is closed. */
const AI_STREAM_ROWS = 8;
const AI_COLLAPSED_ROWS = 4;

/** Body indent, matching the width of the `AI` label so the title aligns with it. */
const AI_INDENT = "   ";

function AiBlock({ item, expanded }: { item: FeedItem; expanded: boolean }) {
  const detail = item.detail ?? [];
  const streaming = item.streaming === true;

  const shown = streaming
    ? detail.slice(-AI_STREAM_ROWS)
    : expanded
      ? detail
      : detail.slice(0, AI_COLLAPSED_ROWS);

  const hidden = streaming || expanded ? 0 : detail.length - shown.length;

  return (
    <AccentBlock accent={color.step}>
      <box flexDirection="row" marginBottom={1} backgroundColor={color.block}>
        <text fg={color.step} bg={color.block}>
          AI
        </text>
        <text fg={color.white} bg={color.block}>
          {` ${item.message}`}
        </text>
      </box>
      {shown.map((line, index) => (
        <text key={index} fg={color.text} bg={color.block}>
          {`${AI_INDENT}${line}`}
        </text>
      ))}
      {hidden > 0 ? (
        <text fg={color.dim} bg={color.block}>
          {`${AI_INDENT}⏵ ${hidden} more lines (alt+↓)`}
        </text>
      ) : null}
    </AccentBlock>
  );
}

function FeedLine({ item, expanded }: { item: FeedItem; expanded: boolean }) {
  if (item.kind === "ai") return <AiBlock item={item} expanded={expanded} />;

  // Step heading: violet, blank line before, marks the step boundary.
  if (item.kind === "step") {
    return (
      <box marginTop={1} marginBottom={1}>
        <text fg={color.step}>{item.message}</text>
      </box>
    );
  }

  return (
    <text>
      <span fg={color.dim}>{`${clock(item.t)}  `}</span>
      {item.host ? <span fg={color.host}>{item.host}</span> : null}
      {item.host ? <span fg={color.white}>{" · "}</span> : null}
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
      minHeight={0}
      focused={focused}
      stickyScroll
      stickyStart="bottom"
      backgroundColor={color.bg}
      paddingLeft={2}
      paddingRight={2}
      contentOptions={{ backgroundColor: color.bg }}
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
const ACTIVE_MAX_ROWS = 6;

export function Active({ state, spinner }: { state: RunState; spinner: string }) {
  const hosts = activeHosts(state);
  if (hosts.length === 0) return null;
  const shown = hosts.slice(0, ACTIVE_MAX_ROWS);

  return (
    <AccentBlock accent={color.accentYellow}>
      {shown.map((host) => (
        <box key={host.name} flexDirection="row" backgroundColor={color.block}>
          <text fg={color.accentYellow} bg={color.block}>
            {`${spinner}  `}
          </text>
          <text fg={color.host} bg={color.block}>
            {host.name.padEnd(11)}
          </text>
          <text fg={color.dim} bg={color.block}>
            {(host.phase ?? "").padEnd(11)}
          </text>
          <text fg={color.dim} bg={color.block}>
            {host.lastLine ?? ""}
          </text>
        </box>
      ))}
      {hosts.length > shown.length ? (
        <text fg={color.dim} bg={color.block}>
          {`+${hosts.length - shown.length} more`}
        </text>
      ) : null}
    </AccentBlock>
  );
}

// -----------------------------------------------------------------------------
// SIDEBAR
// -----------------------------------------------------------------------------

/** Counter width: pads so the bars line up whatever `4/12` or `14/14` measures. */
const COUNTER_WIDTH = 5;

function StepRows({ state, spinner }: { state: RunState; spinner: string }) {
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2}>
      {STEPS.map((step) => {
        const row = state.steps[step];
        const running = row.status === "running";
        const glyph = stepGlyph[row.status] === "" ? spinner : stepGlyph[row.status];
        const background = running ? color.selection : color.panel;
        return (
          <box key={step} flexDirection="row" backgroundColor={background}>
            <text fg={stepColor[row.status]} bg={background}>
              {`${glyph} `}
            </text>
            <text fg={running ? color.white : color.text} bg={background}>
              {STEP_LABELS[step]}
            </text>
            <box flexGrow={1} backgroundColor={background} />
            {row.total > 0 ? (
              <text fg={color.dim} bg={background}>
                {`${progressBar(row.done, row.total)}  ${`${row.done}/${row.total}`.padStart(COUNTER_WIDTH)}`}
              </text>
            ) : null}
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
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
      <box marginTop={1} marginBottom={1}>
        <text fg={color.white} bg={color.panel}>
          {`hosts (${hosts.length}${excluded > 0 ? `, ${excluded} excluded` : ""})`}
        </text>
      </box>
      {hosts.map((host, index) => {
        const current = focused && index === selected;
        const background = current ? color.selection : color.panel;
        const label = ACTIVE_LABEL[host.state] ?? host.state;
        return (
          <box key={host.name} flexDirection="row" backgroundColor={background}>
            <text bg={background}>{`${hostCell(host, spinner)} `}</text>
            <text fg={current ? color.white : color.host} bg={background}>
              {host.name}
            </text>
            <box flexGrow={1} backgroundColor={background} />
            <text fg={hostStateColor[host.state]} bg={background}>
              {label}
            </text>
          </box>
        );
      })}
    </box>
  );
}

/** Product signature, bottom right, opencode style: green dot, name, version. */
function Signature({ version }: { version: string }) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={color.ok} bg={color.panel}>
        {"• "}
      </text>
      <text fg={color.white} bg={color.panel}>
        DNF Fleet Updater
      </text>
      <text fg={color.dim} bg={color.panel}>
        {` ${version}`}
      </text>
    </box>
  );
}

export function Sidebar({
  state,
  spinners,
  selected,
  focused,
}: {
  state: RunState;

  // Two spinners: braille for the steps, pulsing star for the hosts.
  spinners: { step: string; host: string };
  selected: number;
  focused: boolean;
}) {
  return (
    <box flexDirection="column" flexShrink={0} width={36} backgroundColor={color.panel}>
      <box marginTop={1} />
      <StepRows state={state} spinner={spinners.step} />
      <HostRows state={state} spinner={spinners.host} selected={selected} focused={focused} />
      <Signature version={state.run?.version ?? "0.0.0"} />
    </box>
  );
}

// -----------------------------------------------------------------------------
// FOOTER
// -----------------------------------------------------------------------------

/** One line: run summary alternating grey and white, then the only key hint. */
export function Footer({ state }: { state: RunState }) {
  const run = state.run;
  const segments: { text: string; strong: boolean }[] = run
    ? [
        { text: run.mode, strong: true },
        { text: run.codev ? "codev" : "release", strong: false },
        { text: run.aiModel, strong: true },
        { text: `${state.hosts.length} hosts`, strong: false },
        { text: `x${run.maxParallel}`, strong: true },
        { text: run.selection, strong: false },
      ]
    : [{ text: "starting…", strong: false }];

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      {segments.map((segment, index) => (
        <text key={index} fg={segment.strong ? color.white : color.dim}>
          {`${index > 0 ? " · " : ""}${segment.text}`}
        </text>
      ))}
      <box flexGrow={1} />
      {state.end ? (
        <text fg={state.end.exitCode === 0 ? color.ok : color.error}>
          {`${state.end.status} (${state.end.exitCode})  `}
        </text>
      ) : null}
      <text fg={color.white}>?</text>
      <text fg={color.dim}> help</text>
    </box>
  );
}

/** Help callout, raised by `?` and dismissed by Esc. */
export function HelpCallout() {
  const keys: [string, string][] = [
    ["q", "close the current view, quit at the root"],
    ["⇥", "switch focus feed ↔ hosts"],
    ["↑↓", "scroll the focused panel"],
    ["↵", "selected host → logs"],
    ["alt+↓↑", "expand / collapse the AI answer"],
    ["a", "AI dialog"],
    ["^C", "abort"],
    ["esc", "close this callout"],
  ];

  return (
    <AccentBlock accent={color.dim}>
      {keys.map(([key, label]) => (
        <box key={key} flexDirection="row" backgroundColor={color.block}>
          <text fg={color.white} bg={color.block}>
            {key.padEnd(8)}
          </text>
          <text fg={color.dim} bg={color.block}>
            {label}
          </text>
        </box>
      ))}
    </AccentBlock>
  );
}
