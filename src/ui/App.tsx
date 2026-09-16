// Main screen: feed and active region on the left, steps and hosts on the right,
// dialog and footer at the bottom.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Event } from "../model/events.ts";
import { initialState, reduce, visibleHosts, type Ask } from "../model/state.ts";
import { color } from "../model/theme.ts";
import { startReplay, type Replay } from "../engine/replay.ts";
import { Active, Feed, Footer, HelpCallout, Sidebar, useSpinners } from "./panels.tsx";

/** Below this the two columns stop making sense (§ Rendu). */
const MIN_WIDTH = 100;
const MIN_HEIGHT = 24;

const ABORT_ASK: Ask = {
  id: "abort",
  question: "Abort the deployment?",
  options: [
    { value: "wave", label: "finish current wave" },
    { value: "now", label: "stop now" },
    { value: "cancel", label: "cancel" },
  ],
};

type View = "main" | "logs";

export function App({ scenario, speed }: { scenario: string; speed: number }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [view, setView] = useState<View>("main");
  const [focus, setFocus] = useState<"feed" | "hosts">("feed");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [localAsk, setLocalAsk] = useState<Ask | null>(null);
  const [choice, setChoice] = useState(0);
  const [aiPrompt, setAiPrompt] = useState(false);
  const [help, setHelp] = useState(false);
  const replay = useRef<Replay | null>(null);
  const spinner = useSpinners();

  useEffect(() => {
    replay.current = startReplay(scenario, speed, (event: Event) => dispatch(event));
    return () => replay.current?.stop();
  }, [scenario, speed]);

  const hosts = visibleHosts(state);
  const host = hosts[Math.min(selected, Math.max(0, hosts.length - 1))];

  // Engine question wins over a locally raised one: it blocks the stream.
  const ask = state.ask ?? localAsk;

  // A new question always starts on its first button.
  useEffect(() => setChoice(0), [ask?.id]);

  const quit = () => {
    replay.current?.stop();
    renderer.destroy();
    process.exit(state.end?.exitCode ?? 0);
  };

  const answer = (value: string) => {
    if (state.ask) {
      replay.current?.respond(value);
      return;
    }
    if (localAsk?.id === "abort") {
      setLocalAsk(null);
      if (value === "now" || value === "wave") {
        dispatch({
          t: Date.now(),
          kind: "log",
          level: "warn",
          message: value === "now" ? "aborting now" : "aborting after current wave",
        });
        dispatch({ t: Date.now(), kind: "run.end", status: "aborted", exitCode: 5 });
        replay.current?.stop();
      }
      return;
    }
    setLocalAsk(null);
  };

  /** `↵` on the feed expands the last AI block: the only expandable item. */
  const expandLastAi = () => {
    const last = [...state.feed].reverse().find((item) => item.kind === "ai");
    if (!last) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(last.id)) next.delete(last.id);
      else next.add(last.id);
      return next;
    });
  };

  useKeyboard((key) => {
    if (aiPrompt) {
      if (key.name === "escape") setAiPrompt(false);
      return;
    }

    if (ask) {
      const count = ask.options.length;
      if (key.name === "left") setChoice((value) => (value - 1 + count) % count);
      else if (key.name === "right") setChoice((value) => (value + 1) % count);
      else if (key.name === "return") answer(ask.options[choice]!.value);
      else if (key.name === "escape") answer("cancel");
      else if (key.ctrl && key.name === "c") answer("now");
      return;
    }

    if (help) {
      if (key.name === "escape" || key.sequence === "?") setHelp(false);
      return;
    }

    if (key.ctrl && key.name === "c") {
      setLocalAsk(ABORT_ASK);
      return;
    }

    if (key.sequence === "?") {
      setHelp(true);
      return;
    }

    switch (key.name) {
      case "q":
        if (view === "main") quit();
        else setView("main");
        return;
      case "tab":
        setFocus((current) => (current === "feed" ? "hosts" : "feed"));
        return;
      case "a":
        setAiPrompt(true);
        return;
      case "up":
        if (focus === "hosts") setSelected((value) => Math.max(0, value - 1));
        return;
      case "down":
        if (focus === "hosts") setSelected((value) => Math.min(hosts.length - 1, value + 1));
        return;
      case "return":
        if (focus === "hosts" && host) setView("logs");
        else expandLastAi();
        return;
      default:
        break;
    }
  });

  const buttons = useMemo(() => ask?.options ?? [], [ask]);

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <box padding={1} backgroundColor={color.bg}>
        <text fg={color.warn}>{`terminal too small — need ${MIN_WIDTH}x${MIN_HEIGHT}, got ${width}x${height}`}</text>
      </box>
    );
  }

  if (view === "logs" && host) {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={color.bg}>
        <box marginTop={1} marginLeft={2}>
          <text fg={color.white}>{`${host.name} — logs`}</text>
        </box>
        <scrollbox
          flexGrow={1}
          minHeight={0}
          focused
          paddingLeft={2}
          backgroundColor={color.bg}
          contentOptions={{ backgroundColor: color.bg }}
          scrollbarOptions={{ visible: false }}
        >
          {host.logs.length === 0 ? (
            <text fg={color.dim}>no output yet</text>
          ) : (
            host.logs.map((entry, index) => (
              <text key={index}>
                <span fg={color.dim}>{`${entry.phase.padEnd(11)}`}</span>
                <span fg={color.text}>{entry.line}</span>
              </text>
            ))
          )}
        </scrollbox>
        <Footer state={state} />
      </box>
    );
  }

  return (
    <box flexDirection="row" width="100%" height="100%" backgroundColor={color.bg}>
      <box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor={color.bg}>
        <Feed state={state} focused={focus === "feed"} expanded={expanded} />
        <Active state={state} spinner={spinner.host} />

        {ask ? (
          <box
            flexDirection="row"
            flexShrink={0}
            marginTop={1}
            marginLeft={2}
            marginRight={2}
            backgroundColor={color.block}
          >
            <box width={1} backgroundColor={color.accentBlue} />
            <box
              flexDirection="column"
              flexGrow={1}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={color.block}
            >
              <text fg={color.white} bg={color.block}>
                {ask.question}
              </text>
              <box flexDirection="row" marginTop={1} backgroundColor={color.block}>
                {buttons.map((option, index) => {
                  const current = index === choice;
                  return (
                    <text
                      key={option.value}
                      fg={current ? color.bg : color.text}
                      bg={current ? color.accentBlue : color.selection}
                    >
                      {`  ${option.label}  `}
                    </text>
                  );
                })}
                <box flexGrow={1} backgroundColor={color.block} />
                <text fg={color.dim} bg={color.block}>
                  ←→ choose · ↵ confirm
                </text>
              </box>
            </box>
          </box>
        ) : null}

        {aiPrompt ? (
          <box
            flexDirection="row"
            flexShrink={0}
            marginTop={1}
            marginLeft={2}
            marginRight={2}
            backgroundColor={color.block}
          >
            <box width={1} backgroundColor={color.accentBlue} />
            <box
              flexDirection="column"
              flexGrow={1}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={color.block}
            >
              <text fg={color.dim} bg={color.block}>
                ask the AI · esc to close
              </text>
              <input
                focused
                backgroundColor={color.block}
                placeholder="why did nginx fail on nlt?"
                onSubmit={(value) => {
                  setAiPrompt(false);

                  // Prop widens to `string | SubmitEvent`; only the string branch carries text.
                  const question = typeof value === "string" ? value.trim() : "";
                  if (!question) return;
                  dispatch({
                    t: Date.now(),
                    kind: "log",
                    level: "info",
                    message: `you: ${question}`,
                  });
                  dispatch({
                    t: Date.now(),
                    kind: "ai",
                    message: "mockup: no model wired yet",
                    detail: [
                      "The real tool answers here, with the tools of the",
                      "current --ai-analysis level.",
                    ],
                  });
                }}
              />
            </box>
          </box>
        ) : null}

        {help ? <HelpCallout /> : null}

        <Footer state={state} />
      </box>

      <Sidebar
        state={state}
        spinners={spinner}
        selected={selected}
        focused={focus === "hosts"}
      />
    </box>
  );
}
