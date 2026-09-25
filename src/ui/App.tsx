// Main screen: feed and active region on the left, steps and hosts on the right,
// dialog and footer at the bottom.

import { ClipboardTarget } from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Event, RunControl, RunSource } from "../model/events.ts";
import { type Ask, initialState, reduce, visibleHosts } from "../model/state.ts";
import { color } from "../model/theme.ts";
import {
  AccentBlock,
  Active,
  Feed,
  Footer,
  HelpCallout,
  HostLogs,
  SIDEBAR_WIDTH,
  Sidebar,
  useSpinners,
} from "./panels.tsx";

/** Below this the two columns stop making sense (§ Rendu). */
const MIN_WIDTH = 100;
const MIN_HEIGHT = 24;

/** Labels never repeat the question: it is right above the buttons. */
const ABORT_ASK: Ask = {
  id: "abort",
  question: "Abort the deployment?",
  options: [
    { value: "after-wave", label: "after wave" },
    { value: "now", label: "now" },
    { value: "cancel", label: "cancel" },
  ],
};

/** `s`: killed like `now`, but the interface stays open for inspection. */
const STOP_ASK: Ask = {
  id: "stop",
  question: "Stop the deployment now?",
  options: [
    { value: "stop", label: "yes" },
    { value: "cancel", label: "no" },
  ],
};

type View = "main" | "logs";

export interface AppProps {
  /** Live run, bound by `main.tsx`. Absent: a still frame, for the capture harness. */
  source?: RunSource;

  // Capture harness: fold these events first.
  preload?: Event[];
  initialView?: View;
  initialSelected?: number;

  /** `q` once the run ended. Absent: the renderer is destroyed and the process exits. */
  onQuit?: (exitCode: number) => void;
}

export function App({
  source,
  preload,
  initialView = "main",
  initialSelected = 0,
  onQuit,
}: AppProps) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    (preload ?? []).reduce(reduce, initialState()),
  );
  const [view, setView] = useState<View>(initialView);
  const [focus, setFocus] = useState<"feed" | "hosts">("feed");
  const [selected, setSelected] = useState(initialSelected);
  const [localAsk, setLocalAsk] = useState<Ask | null>(null);
  const [choice, setChoice] = useState(0);
  const [aiPrompt, setAiPrompt] = useState(false);
  const [help, setHelp] = useState(false);
  const [quitOnEnd, setQuitOnEnd] = useState(false);
  const control = useRef<RunControl | null>(null);
  const spinner = useSpinners();

  useEffect(() => {
    if (source) control.current = source((event: Event) => dispatch(event));
  }, [source]);

  const hosts = visibleHosts(state);
  const host = hosts[Math.min(selected, Math.max(0, hosts.length - 1))];

  // The abort dialog is raised on purpose over a pending question, which stays pending.
  const ask = localAsk ?? state.ask;

  // A new question always starts on its first button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ask.id` is the trigger, not an input.
  useEffect(() => setChoice(0), [ask?.id]);

  const quit = (exitCode: number) => {
    if (onQuit) {
      onQuit(exitCode);
      return;
    }
    renderer.destroy();
    process.exit(exitCode);
  };

  // Abort `now`: commands killed and report written, nothing left to watch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `quit` reads only `onQuit` and the renderer, both stable.
  useEffect(() => {
    if (quitOnEnd && state.end) quit(state.end.exitCode);
  }, [quitOnEnd, state.end]);

  // Before the end, commands still run in their own process groups: abort first.
  const quitOrAbort = () => {
    if (state.end) quit(state.end.exitCode);
    else setLocalAsk(ABORT_ASK);
  };

  /** Over a pending question too: it stays pending behind the dialog. */
  const askStop = () => {
    if (!state.end) setLocalAsk(STOP_ASK);
  };

  const answer = (value: string) => {
    if (!localAsk) {
      control.current?.respond(value);
      return;
    }
    setLocalAsk(null);
    if (value === "after-wave") control.current?.abort("after-wave");
    if (value === "now" || value === "stop") control.current?.abort("now");
    if (value === "now") setQuitOnEnd(true);
  };

  const moveSelection = (delta: number) =>
    setSelected((value) => Math.max(0, Math.min(hosts.length - 1, value + delta)));

  useKeyboard((key) => {
    if (aiPrompt) {
      if (key.name === "escape") setAiPrompt(false);
      return;
    }

    if (help) {
      if (key.name === "escape" || key.sequence === "?") setHelp(false);
      return;
    }

    // Log view first: a pending question waits behind it, hidden.
    if (view === "logs") {
      if (key.name === "escape" || key.name === "q") setView("main");
      else if (key.name === "up") moveSelection(-1);
      else if (key.name === "down") moveSelection(1);
      else if (key.ctrl && key.name === "c") {
        setView("main");
        quitOrAbort();
      } else if (key.name === "s") {
        setView("main");
        askStop();
      }
      return;
    }

    if (ask) {
      const count = ask.options.length;
      const onHosts = focus === "hosts";
      if (key.name === "tab") {
        // The host table and its logs stay reachable before answering.
        setFocus(onHosts ? "feed" : "hosts");
      } else if (onHosts && (key.name === "up" || key.name === "down")) {
        moveSelection(key.name === "up" ? -1 : 1);
      } else if (key.name === "left") {
        setChoice((value) => (value - 1 + count) % count);
      } else if (key.name === "right") {
        setChoice((value) => (value + 1) % count);
      } else if (key.name === "return") {
        if (!onHosts) answer(ask.options[choice]!.value);
        else if (host) setView("logs");
      } else if (key.name === "escape" && localAsk) {
        // An engine question has no cancel: only its options are answers.
        answer("cancel");
      } else if (key.ctrl && key.name === "c") {
        if (localAsk) answer("now");
        else quitOrAbort();
      } else if (key.name === "s" && !localAsk) {
        askStop();
      }
      return;
    }

    if (key.ctrl && key.name === "c") {
      quitOrAbort();
      return;
    }

    if (key.sequence === "?") {
      setHelp(true);
      return;
    }

    switch (key.name) {
      case "q":
        quitOrAbort();
        return;
      case "s":
        askStop();
        return;
      case "p":
        if (!state.end) control.current?.ping();
        return;
      case "tab":
        setFocus((current) => (current === "feed" ? "hosts" : "feed"));
        return;
      case "a":
        setAiPrompt(true);
        return;
      case "up":
        if (focus === "hosts") moveSelection(-1);
        return;
      case "down":
        if (focus === "hosts") moveSelection(1);
        return;
      case "return":
        if (focus === "hosts" && host) setView("logs");
        return;
      default:
        break;
    }
  });

  // Copy on select, like the terminal: mouse capture takes its own selection away.
  // OSC 52, so it also reaches the local clipboard over ssh.
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text) return;
    renderer.copyToClipboardOSC52(text, ClipboardTarget.Clipboard);
    renderer.copyToClipboardOSC52(text, ClipboardTarget.Primary);
  });

  const buttons = useMemo(() => ask?.options ?? [], [ask]);

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <box padding={1} backgroundColor={color.bg}>
        <text
          fg={color.warn}
        >{`terminal too small — need ${MIN_WIDTH}x${MIN_HEIGHT}, got ${width}x${height}`}</text>
      </box>
    );
  }

  const logView = view === "logs" && host !== undefined;

  return (
    <box flexDirection="row" width="100%" height="100%" backgroundColor={color.bg}>
      <box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor={color.bg}>
        {logView ? (
          <HostLogs host={host} />
        ) : (
          <>
            <Feed state={state} focused={focus === "feed"} />
            <Active state={state} spinner={spinner.host} />
          </>
        )}

        {ask && !logView ? (
          <AccentBlock accent={color.accentBlue}>
            <text fg={color.white} bg={color.block}>
              {ask.question}
            </text>
            <box flexDirection="row" marginTop={1} backgroundColor={color.block}>
              {buttons.map((option, index) => {
                const current = index === choice;
                return (
                  <box key={option.value} flexDirection="row" backgroundColor={color.block}>
                    <text
                      fg={current ? color.bg : color.text}
                      bg={current ? color.accentBlue : color.selection}
                    >
                      {`  ${option.label}  `}
                    </text>
                    <text bg={color.block}>{"  "}</text>
                  </box>
                );
              })}
              <box flexGrow={1} backgroundColor={color.block} />
              <text fg={color.dim} bg={color.block}>
                {focus === "hosts" ? "⇥ back to answer  " : "↔ choose  "}
              </text>
              <text fg={color.white} bg={color.block}>
                {focus === "hosts" ? "↵ host logs" : "↵ confirm"}
              </text>
            </box>
          </AccentBlock>
        ) : null}

        {aiPrompt ? (
          <AccentBlock accent={color.accentBlue}>
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

                // The engine echoes the question and streams the answer back.
                control.current?.askAi(question);
              }}
            />
          </AccentBlock>
        ) : null}

        {help ? <HelpCallout /> : null}

        <Footer state={state} width={width - SIDEBAR_WIDTH} />
      </box>

      <Sidebar
        state={state}
        spinners={spinner}
        selected={selected}
        focused={focus === "hosts"}
        band={logView}
      />
    </box>
  );
}
