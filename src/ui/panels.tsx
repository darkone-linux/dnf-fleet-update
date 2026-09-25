// Panels of the main screen. Presentation only: everything comes from RunState.

import { SyntaxStyle, TextAttributes } from "@opentui/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AI_LABEL } from "../model/ai-labels.ts";
import { type RunInfo, STEP_LABELS, STEPS } from "../model/events.ts";
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

/** Steps and hosts column, fixed: the footer measures the width left to it. */
export const SIDEBAR_WIDTH = 36;

/** Tail of the footer, never dropped, and the gap kept before it. */
const HELP_HINT = "? help";
const HELP_GAP = 2;

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

/**
 * Elapsed run time, ticking between events. Anchored on the engine clock, so a
 * replay or a resumed run never drifts onto wall time. Frozen once ended.
 */
export function useElapsed(state: RunState): number {
  const frozen = Boolean(process.env.FLEET_CAPTURE) || state.end !== undefined;
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef({ t: state.t, at: now });

  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [frozen]);

  if (anchor.current.t !== state.t) anchor.current = { t: state.t, at: Date.now() };
  if (frozen) return state.t;

  // Clamped: a tick predating the anchor would run the chronometer backwards.
  return state.t + Math.max(0, now - anchor.current.at);
}

const ELAPSED_INTERVAL_MS = 500;

function hostCell(shown: ShownState, spinner: string): string {
  const glyph = hostGlyph[shown];
  return glyph === "" ? padGlyph(spinner, false) : glyph;
}

const ACTIVE_LABEL: Partial<Record<ShownState, string>> = {
  building: "building",
  copying: "copying",
  testing: "testing",
  switching: "switching",
  repairing: "under repair",
  "ai-analysing": `${AI_LABEL} analysis`,
  "ai-repairing": `${AI_LABEL} repair`,
};

/** Someone is working on that host right now: the label blinks (§ États affichés). */
const BLINKING: ReadonlySet<ShownState> = new Set<ShownState>([
  "repairing",
  "ai-analysing",
  "ai-repairing",
]);

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

/** Rolling window while the answer streams; shown whole once it is closed. */
const AI_STREAM_ROWS = 8;

function highlightedLabels(message: string, foreground: string): ReactNode[] {
  return message.split(/(\b(?:AI|YOU)\b)/gi).map((part, index) => {
    const tint = /^(?:AI|YOU)$/i.test(part) ? color.magenta : foreground;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: stateless message fragments, position is identity.
      <span key={index} fg={tint}>
        {part}
      </span>
    );
  });
}

function AiBlock({ item }: { item: FeedItem }) {
  const detail = item.detail ?? [];
  const streaming = item.streaming === true;
  const syntaxStyle = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        "markup.heading": { fg: color.white, bold: true },
        "markup.list": { fg: color.dim },
        "markup.strong": { bold: true },
      }),
    [],
  );

  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);

  // Whole once closed: the feed scrolls, so any past answer stays readable.
  const shown = streaming ? detail.slice(-AI_STREAM_ROWS) : detail;

  return (
    <AccentBlock accent={color.magenta}>
      <box marginBottom={1} backgroundColor={color.block}>
        <text fg={color.white} bg={color.block} attributes={TextAttributes.BOLD}>
          <span fg={color.magenta}>{AI_LABEL}</span> {highlightedLabels(item.message, color.white)}
        </text>
      </box>
      <box paddingLeft={GUTTER}>
        <markdown
          content={shown.join("\n")}
          syntaxStyle={syntaxStyle}
          fg={color.text}
          bg={color.block}
          streaming={streaming}
        />
      </box>
    </AccentBlock>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  // Blocks span the full width: no gutter, the rule sits on the left edge.
  if (item.kind === "ai") return <AiBlock item={item} />;

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
        {highlightedLabels(item.message, levelColor[item.level])}
      </text>
    </box>
  );
}

export function Feed({ state, focused }: { state: RunState; focused: boolean }) {
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
        <FeedLine key={item.id} item={item} />
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

/** Gap kept after the longest host name, and width of the phase column. */
const NAME_GAP = 2;
const PHASE_WIDTH = 11;

export function Active({ state, spinner }: { state: RunState; spinner: string }) {
  const hosts = activeHosts(state);
  if (hosts.length === 0) return null;
  const shown = hosts.slice(0, ACTIVE_MAX_ROWS);

  // Measured on the whole fleet, not on the active rows: the phase column
  // never slides as hosts come and go.
  const nameWidth = Math.max(...state.hosts.map((host) => host.name.length)) + NAME_GAP;

  return (
    <AccentBlock accent={color.accentYellow}>
      {shown.map((host) => (
        <box key={host.name} flexDirection="row" backgroundColor={color.block}>
          {/* `flexShrink` 0: an output line too long to wrap would otherwise
              eat the padding of the columns before it. */}
          <text fg={color.accentYellow} bg={color.block} flexShrink={0}>
            {`${spinner}  `}
          </text>
          <text fg={color.host} bg={color.block} flexShrink={0}>
            {host.name.padEnd(nameWidth)}
          </text>
          <text fg={color.white} bg={color.block} flexShrink={0}>
            {(host.phase ?? "").padEnd(PHASE_WIDTH)}
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

function StepRows({
  state,
  spinner,
  elapsed,
}: {
  state: RunState;
  spinner: string;

  /** Chronometer, right of the first row: the top right corner of the screen. */
  elapsed: number;
}) {
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2}>
      {STEPS.map((step) => {
        const row = state.steps[step];
        const running = row.status === "running";
        const glyph = stepGlyph[row.status] === "" ? spinner : stepGlyph[row.status];

        // Ruled out by the options (`--build-only`): name as dim as its cross.
        const name = row.status === "omitted" ? color.dim : color.text;

        // No band on the running step: its spinner already names it.
        return (
          <box key={step} flexDirection="row" backgroundColor={color.panel}>
            <text fg={stepColor[row.status]} bg={color.panel}>
              {`${glyph} `}
            </text>
            <text fg={running ? color.accentYellow : name} bg={color.panel}>
              {STEP_LABELS[step]}
            </text>
            <box flexGrow={1} backgroundColor={color.panel} />
            {step === STEPS[0] ? (
              <text fg={color.magenta} bg={color.panel}>
                {clock(elapsed)}
              </text>
            ) : null}
            {row.total > 0 ? (
              <text fg={color.dim} bg={color.panel}>
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
            <text
              fg={stateColor}
              bg={background}
              attributes={BLINKING.has(shown) ? TextAttributes.BLINK : TextAttributes.NONE}
            >
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
  const elapsed = useElapsed(state);

  return (
    <box flexDirection="column" flexShrink={0} width={SIDEBAR_WIDTH} backgroundColor={color.panel}>
      <box marginTop={1} />
      <StepRows state={state} spinner={spinners.step} elapsed={elapsed} />
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

/** Keys of the run summary, in display order. */
type FooterKey = "mode" | "codev" | "ai" | "hosts" | "parallel" | "selection";

interface FooterSegment {
  key: FooterKey;
  text: string;
}

const FOOTER_COLOR: Record<FooterKey, string> = {
  mode: color.accentYellow,
  codev: color.white,
  ai: color.magenta,
  hosts: color.ok,
  parallel: color.error,
  selection: color.host,
};

const SEPARATOR = " · ";

/** Dropped first when the footer is too narrow; the operation always stays. */
const FOOTER_DROP_ORDER: FooterKey[] = ["parallel", "selection", "ai", "codev", "hosts"];

/** Columns the segments and their separators occupy. */
function footerWidth(segments: FooterSegment[]): number {
  const text = segments.reduce((total, segment) => total + segment.text.length, 0);
  return text + Math.max(0, segments.length - 1) * SEPARATOR.length;
}

/**
 * Segments that fit `room` columns, in display order. Nothing wraps: a short
 * window shows fewer facts rather than broken ones.
 */
function fitFooter(segments: FooterSegment[], room: number): FooterSegment[] {
  let kept = segments;
  for (const key of FOOTER_DROP_ORDER) {
    if (footerWidth(kept) <= room) break;
    kept = kept.filter((segment) => segment.key !== key);
  }
  return kept;
}

/** Both axes `none`: the tool and its model are noise, nothing will ask them. */
function aiEnabled(run: RunInfo): boolean {
  const params = run.params;

  // Recorded streams carry no parameters: they keep what they were captured with.
  if (params === undefined) return true;
  return params.aiAnalysis !== "none" || params.aiErrorAction !== "none";
}

function runSegments(run: RunInfo, hosts: number): FooterSegment[] {
  const segments: FooterSegment[] = [{ key: "mode", text: run.mode }];
  if (run.codev) segments.push({ key: "codev", text: "codev" });
  if (aiEnabled(run)) segments.push({ key: "ai", text: run.aiModel });
  segments.push(
    { key: "hosts", text: `${hosts} hosts` },
    { key: "parallel", text: `x${run.maxParallel}` },
    { key: "selection", text: run.selection },
  );
  return segments;
}

/** One line: run facts in color, then the only key hint. */
export function Footer({ state, width }: { state: RunState; width: number }) {
  const run = state.run;
  const segments: FooterSegment[] = run
    ? runSegments(run, state.hosts.length)
    : [{ key: "mode", text: "starting…" }];

  const end = state.end ? `${state.end.status} (${state.end.exitCode})  ` : "";

  // Gutters, the end status and `? help` are never given up.
  const shown = fitFooter(segments, width - 2 * GUTTER - end.length - HELP_HINT.length - HELP_GAP);

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      marginTop={1}
      marginBottom={1}
      paddingLeft={GUTTER}
      paddingRight={GUTTER}
    >
      {shown.map((segment, index) => (
        <box key={segment.key} flexDirection="row">
          {/* Separators stay grey whatever the segment they precede. */}
          {index > 0 ? <text fg={color.dim}>{SEPARATOR}</text> : null}
          <text fg={FOOTER_COLOR[segment.key]}>{segment.text}</text>
        </box>
      ))}
      <box flexGrow={1} />
      {end ? <text fg={state.end?.exitCode === 0 ? color.ok : color.error}>{end}</text> : null}
      <text fg={color.white}>?</text>
      <text fg={color.dim}> help</text>
    </box>
  );
}

/** Help callout, raised by `?` and dismissed by Esc. */
export function HelpCallout() {
  const keys: [string, string][] = [
    ["q", "close the current view; at the root, abort, or quit once ended"],
    ["⇥", "switch focus feed ↔ hosts"],
    ["↑↓", "scroll, or change host in the log view"],
    ["↵", "selected host → logs"],
    ["a", "AI dialog"],
    ["p", "ping the tracked hosts now"],
    ["s", "stop now, stay to inspect"],
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
