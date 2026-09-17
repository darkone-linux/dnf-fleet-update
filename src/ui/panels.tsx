// Panels of the main screen. Presentation only: everything comes from RunState.

import { TextAttributes } from "@opentui/core";
import { type ReactNode, useEffect, useState } from "react";
import { STEP_LABELS, STEPS } from "../model/events.ts";
import {
  activeHosts,
  excludedCount,
  type FeedItem,
  type HostRow,
  type RunState,
  type ShownState,
  shownState,
  visibleHosts,
} from "../model/state.ts";
import {
  clock,
  color,
  HOST_SPINNER,
  hostGlyph,
  hostStateColor,
  levelColor,
  padGlyph,
  progressBar,
  SPINNER_INTERVAL_MS,
  STEP_SPINNER,
  stepColor,
  stepGlyph,
} from "../model/theme.ts";

/** Text column: blocks reach it through border (1) + padding (2), lines through padding. */
const GUTTER = 3;

/**
 * Single ticker for every spinner on screen. Frozen under capture, where a
 * moving frame would never reach visual idle.
 */
export function useSpinners(): { step: string; host: string } {
  const frozen = Boolean(process.env.FLEET_CAPTURE);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [frozen]);

  // Frozen captures land on a mid-cycle frame: `·` is the pulse at its faintest
  // and reads as a bullet, not as a spinner.
  const index = frozen ? FROZEN_FRAME : frame;

  return {
    step: STEP_SPINNER[index % STEP_SPINNER.length] ?? "⠋",
    host: HOST_SPINNER[index % HOST_SPINNER.length] ?? "✳",
  };
}

const FROZEN_FRAME = 4;

function hostCell(shown: ShownState, spinner: string): string {
  const glyph = hostGlyph[shown];
  return glyph === "" ? padGlyph(spinner, false) : glyph;
}

const ACTIVE_LABEL: Partial<Record<ShownState, string>> = {
  building: "building",
  copying: "copying",
  testing: "testing",
  switching: "switching",
};

/**
 * Only `vertical` is ever drawn: the blocks carry a left border and nothing
 * else. `🭵` is a one-eighth bar sitting at the RIGHT of its cell, so the
 * colour lands flush against the grey surface; a left-hand bar such as `▎`
 * leaves a whole cell of dead black between the two. Swap for `🭴` (U+1FB74)
 * to move the bar one eighth further left.
 */
const RULE_CHARS = {
  vertical: "🭵",
  horizontal: " ",
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
};

/**
 * Grey callout with a thin accent rule on its own left edge, the block itself
 * inset from the screen. Shared by the active region, the AI answers, the
 * questions and the help, so every block spans the same width.
 *
 * Margin 1 + border 1 + padding 1 lands the text on GUTTER, aligned with the
 * feed lines around it.
 */
export function AccentBlock({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      marginLeft={1}
      marginRight={2}
    >
      {/* A border inherits its own box background, so the rule gets a box of
          its own to sit on the page black rather than on the grey surface.
          The glyph carries the bar on its right edge, so the gap before the
          text is the grey padding below, not dead black. */}
      <box
        width={1}
        backgroundColor={color.bg}
        border={["left"]}
        borderColor={accent}
        customBorderChars={RULE_CHARS}
      />

      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={color.block}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        {children}
      </box>
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
      <box marginBottom={1} backgroundColor={color.block}>
        <text fg={color.white} bg={color.block} attributes={TextAttributes.BOLD}>
          {`AI ${item.message}`}
        </text>
      </box>
      {shown.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless text rows, position is their identity.
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
  // Blocks span the full width: no gutter, the rule sits on the left edge.
  if (item.kind === "ai") return <AiBlock item={item} expanded={expanded} />;

  if (item.kind === "step") {
    return (
      <box marginTop={1} marginBottom={1} paddingLeft={GUTTER}>
        <text fg={color.step}>{item.message}</text>
      </box>
    );
  }

  return (
    <box paddingLeft={GUTTER} paddingRight={GUTTER}>
      <text>
        <span fg={color.dim}>{`${clock(item.t)}  `}</span>
        {item.host ? <span fg={color.host}>{item.host}</span> : null}
        {item.host ? <span fg={color.white}>{" · "}</span> : null}
        <span fg={levelColor[item.level]}>{item.message}</span>
      </text>
    </box>
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
// HOST LOGS
// -----------------------------------------------------------------------------

/** Replaces the feed in place: the side column and the status bar never move. */
export function HostLogs({ host }: { host: HostRow }) {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor={color.bg}>
      <box marginTop={1} marginBottom={1} paddingLeft={GUTTER}>
        <text fg={color.white} attributes={TextAttributes.BOLD}>
          {`${host.name} — logs`}
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        focused
        stickyScroll
        stickyStart="bottom"
        backgroundColor={color.bg}
        contentOptions={{ backgroundColor: color.bg }}
        scrollbarOptions={{ visible: false }}
      >
        {host.logs.length === 0 ? (
          <box paddingLeft={GUTTER}>
            <text fg={color.dim}>no output yet</text>
          </box>
        ) : (
          host.logs.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stateless text rows, position is their identity.
            <box key={index} paddingLeft={GUTTER} paddingRight={GUTTER}>
              <text>
                <span fg={color.dim}>{`${entry.phase.padEnd(11)}`}</span>
                <span fg={color.text}>{entry.line}</span>
              </text>
            </box>
          ))
        )}
      </scrollbox>
      <box paddingLeft={GUTTER}>
        <text fg={color.dim}>↑↓ host · esc back</text>
      </box>
    </box>
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
  band,
}: {
  state: RunState;
  spinner: string;
  selected: number;
  focused: boolean;

  /** Log view: the host being read wears a cyan band — yellow clashed with the weather glyphs. */
  band: boolean;
}) {
  const hosts = visibleHosts(state);
  const excluded = excludedCount(state);

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
      <box marginTop={1} marginBottom={1}>
        <text fg={color.white} bg={color.panel} attributes={TextAttributes.BOLD}>
          {`hosts (${hosts.length}${excluded > 0 ? `, ${excluded} excluded` : ""})`}
        </text>
      </box>
      {hosts.map((host, index) => {
        const current = (focused || band) && index === selected;
        const background = current ? (band ? color.host : color.selection) : color.panel;
        const nameColor = current ? (band ? color.bg : color.white) : color.host;
        const shown = shownState(host);
        const stateColor = current && band ? color.bg : hostStateColor[shown];
        const label = ACTIVE_LABEL[shown] ?? shown;
        return (
          <box key={host.name} flexDirection="row" backgroundColor={background}>
            <text bg={background}>{`${hostCell(shown, spinner)} `}</text>
            <text fg={nameColor} bg={background}>
              {host.name}
            </text>
            <box flexGrow={1} backgroundColor={background} />
            <text fg={stateColor} bg={background}>
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
  band,
}: {
  state: RunState;

  // Two spinners: braille for the steps, pulsing star for the hosts.
  spinners: { step: string; host: string };
  selected: number;
  focused: boolean;
  band: boolean;
}) {
  return (
    <box flexDirection="column" flexShrink={0} width={36} backgroundColor={color.panel}>
      <box marginTop={1} />
      <StepRows state={state} spinner={spinners.step} />
      <HostRows
        state={state}
        spinner={spinners.host}
        selected={selected}
        focused={focused}
        band={band}
      />
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
      paddingLeft={GUTTER}
      paddingRight={GUTTER}
    >
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed status segments, position is their identity.
        <box key={index} flexDirection="row">
          {/* Separators stay grey whatever the segment they precede. */}
          {index > 0 ? <text fg={color.dim}>{" · "}</text> : null}
          <text fg={segment.strong ? color.white : color.dim}>{segment.text}</text>
        </box>
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
    ["↑↓", "scroll, or change host in the log view"],
    ["↵", "selected host → logs"],
    ["alt+↓↑", "expand / collapse the AI answer"],
    ["a", "AI dialog"],
    ["^C", "abort"],
    ["esc", "close this callout, leave the log view"],
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
