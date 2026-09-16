// Main screen: feed and active region on the left, steps and hosts on the right,
// dialog and footer at the bottom.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Event } from "../model/events.ts";
import { initialState, reduce, visibleHosts, type Ask } from "../model/state.ts";
import { color } from "../model/theme.ts";
import { startReplay, type Replay } from "../engine/replay.ts";
import { Active, Feed, Keys, Sidebar, StatusBar, useSpinner } from "./panels.tsx";

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

type View = "main" | "logs" | "help";

export function App({ scenario, speed }: { scenario: string; speed: number }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [view, setView] = useState<View>("main");
  const [focus, setFocus] = useState<"feed" | "hosts">("feed");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [localAsk, setLocalAsk] = useState<Ask | null>(null);
  const [aiPrompt, setAiPrompt] = useState(false);
  const replay = useRef<Replay | null>(null);
  const spinner = useSpinner();

  useEffect(() => {
    replay.current = startReplay(scenario, speed, (event: Event) => dispatch(event));
    return () => replay.current?.stop();
  }, [scenario, speed]);

  const hosts = visibleHosts(state);
  const host = hosts[Math.min(selected, Math.max(0, hosts.length - 1))];

  // Engine question wins over a locally raised one: it blocks the stream.
  const ask = state.ask ?? localAsk;

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

  useKeyboard((key) => {
    if (aiPrompt) {
      if (key.name === "escape") setAiPrompt(false);
      return;
    }

    if (ask) {
      const index = ask.options.findIndex((option) => option.value.startsWith(key.name));
      if (key.name === "escape") answer("cancel");
      else if (index >= 0) answer(ask.options[index]!.value);
      else if (key.ctrl && key.name === "c") answer("now");
      return;
    }

    if (key.ctrl && key.name === "c") {
      setLocalAsk(ABORT_ASK);
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

    if (key.sequence === "?") setView((current) => (current === "help" ? "main" : "help"));
  });

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

  const options = useMemo(
    () => ask?.options.map((option) => ({ name: option.label, description: "", value: option.value })) ?? [],
    [ask],
  );

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <box padding={1}>
        <text fg={color.warn}>{`terminal too small — need ${MIN_WIDTH}x${MIN_HEIGHT}, got ${width}x${height}`}</text>
      </box>
    );
  }

  if (view === "logs" && host) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        <scrollbox flexGrow={1} focused paddingLeft={1} title={` ${host.name} — logs `}>
          {host.logs.length === 0 ? (
            <text fg={color.dim}>no output yet</text>
          ) : (
            host.logs.map((entry, index) => (
              <text key={index}>
                <span fg={color.dim}>{`${entry.phase.padEnd(10)} `}</span>
                <span fg={color.text}>{entry.line}</span>
              </text>
            ))
          )}
        </scrollbox>
        <Keys view="logs" />
      </box>
    );
  }

  if (view === "help") {
    return (
      <box flexDirection="column" padding={1} width="100%" height="100%">
        <text fg={color.text}>Keys</text>
        <text fg={color.dim}>q   close the current view, quit at the root</text>
        <text fg={color.dim}>⇥   switch focus feed ↔ hosts</text>
        <text fg={color.dim}>↑↓  scroll the focused panel</text>
        <text fg={color.dim}>↵   selected host → logs, AI block → expand</text>
        <text fg={color.dim}>a   AI dialog</text>
        <text fg={color.dim}>^C  abort</text>
        <text fg={color.dim}>?   this help</text>
      </box>
    );
  }

  return (
    <box flexDirection="row" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1}>
        <Feed state={state} focused={focus === "feed"} expanded={expanded} />
        <Active state={state} spinner={spinner} />

        {ask ? (
          <box flexDirection="column" border={["top", "right"]} borderColor={color.warn} paddingLeft={1}>
            <text fg={color.warn}>{ask.question}</text>
            <select
              focused
              options={options}
              showDescription={false}
              onSelect={(_index, option) => answer(String(option?.value ?? "cancel"))}
            />
          </box>
        ) : null}

        {aiPrompt ? (
          <box flexDirection="column" border={["top", "right"]} borderColor={color.ai} paddingLeft={1}>
            <text fg={color.ai}>ask the AI (esc to close)</text>
            <input
              focused
              placeholder="why did nginx fail on nlt?"
              onSubmit={(value) => {
                setAiPrompt(false);

                // Prop widens to `string | SubmitEvent`; only the string branch carries text.
                const question = typeof value === "string" ? value.trim() : "";
                if (!question) return;
                dispatch({ t: Date.now(), kind: "log", level: "info", message: `you: ${question}` });
                dispatch({
                  t: Date.now(),
                  kind: "ai",
                  message: "mockup: no model wired yet",
                  detail: ["The real tool answers here, with the tools of the current --ai-analysis level."],
                });
              }}
            />
          </box>
        ) : null}

        <StatusBar state={state} />
        <Keys view={view} />
      </box>

      <Sidebar state={state} spinner={spinner} selected={selected} focused={focus === "hosts"} />
    </box>
  );
}
