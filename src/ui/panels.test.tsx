// Active region: the columns must hold whatever the output line measures.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { Event } from "../model/events.ts";
import { App } from "./App.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;

/** Left rule of the accent block, drawn on every one of its rows. */
const RULE = "\u{1FB75}";

let current: Setup | undefined;
const forward = console.error;

// Frozen spinners: a ticking frame never reaches visual idle.
beforeAll(() => {
  process.env.FLEET_CAPTURE = "1";

  // Preloaded state, no update from act(): only the warning would be left.
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("was not wrapped in act")) return;
    forward(...args);
  };
});

afterAll(() => {
  delete process.env.FLEET_CAPTURE;
  console.error = forward;
});

afterEach(() => {
  current?.renderer.destroy();
  current = undefined;
});

const LONG_LINE =
  "copying path '/nix/store/zlk9jw06si1j35fhcp0imfll1c8cqqyi-fontconfig-2.18.3-bin' from 'http://10.1.2.1:5000'...";

const add = (host: string): Event[] => [
  { t: 0, kind: "host.add", host, profile: "desktop", zone: "ag" },
  { t: 0, kind: "host.state", host, state: "building" },
  { t: 0, kind: "host.state", host, state: "built" },
  { t: 0, kind: "host.state", host, state: "copying" },
];

const PRELOAD: Event[] = [
  ...add("vbox-umi"),
  ...add("vbox-test"),
  { t: 0, kind: "host.output", host: "vbox-test", phase: "copy", line: LONG_LINE },
];

async function render(width: number): Promise<Setup> {
  const setup = await testRender(<App preload={PRELOAD} />, { width, height: 30 });
  current = setup;
  await setup.waitForVisualIdle();
  return setup;
}

test("host names aligned on the longest of the fleet, whatever the output line", async () => {
  const setup = await render(110);

  // The rule glyph of the block: the host table names the same hosts.
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.includes(RULE));

  // `vbox-test` is the longest name: 9 columns, plus the 2 of the gap.
  expect(rows.find((row) => row.includes("vbox-umi"))).toContain("vbox-umi   ");
  expect(rows.find((row) => row.includes("vbox-test"))).toContain("vbox-test  copy");
});

test("the phase of an active host is white, the output line dim", async () => {
  const setup = await render(110);
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);

  /** Foreground of the first span starting with `text`, as `#rrggbb`. */
  const hex = (text: string) =>
    spans
      .find((span) => span.text.startsWith(text))
      ?.fg?.toInts()
      .slice(0, 3)
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("");

  expect(hex("copy ")).toBe("ffffff");
  expect(hex("copying path")).toBe("7a7a7a");
});
