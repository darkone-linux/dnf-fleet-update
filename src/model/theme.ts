// Palette, glyphs and spinners.
//
// Single source for the interface: `--no-ui` renders the same events without
// any of it.

import type { Level } from "./events.ts";
import type { ShownState, StepStatus } from "./state.ts";

export const color = {
  // Surfaces: black centre, grey side column, grey callout blocks. No rules
  // between them — the background change carries the separation.
  bg: "#0a0a0a",
  panel: "#121212",
  block: "#1c1c1c",
  selection: "#2a2f3a",

  text: "#e6e6e6",
  white: "#ffffff",
  dim: "#7a7a7a",

  host: "#4ec9d9",
  step: "#b191f2",
  accentBlue: "#5b9df9",
  accentYellow: "#e0b341",

  ok: "#5fd75f",
  error: "#f97066",
  warn: "#e0b341",
} as const;

export const levelColor: Record<Level, string> = {
  info: color.text,
  ok: color.ok,
  warn: color.warn,
  error: color.error,
};

/**
 * Weather metaphor: the run clears up as hosts land, `☀️` being a deployed
 * host. Active states take the spinner instead (empty glyph).
 */
export const hostGlyph: Record<ShownState, string> = {
  pending: "☁️",
  building: "",
  copying: "",
  testing: "",
  switching: "",
  built: "🌥️",
  tested: "🌤️",
  deployed: "☀️",

  // A unit that did not start is a lighter failure than a broken host.
  error: "🌦️",
  failed: "🌧️",
  reverted: "🔄",
  excluded: "⛔",
  interrupted: "🌩️",
  offline: "💤",
  unknown: "❔",
};

export const hostStateColor: Record<ShownState, string> = {
  pending: color.dim,
  building: color.text,
  copying: color.text,
  testing: color.text,
  switching: color.text,
  built: color.text,
  tested: color.text,
  deployed: color.ok,
  error: color.warn,
  failed: color.error,
  reverted: color.dim,
  excluded: color.dim,
  interrupted: color.warn,
  offline: color.dim,
  unknown: color.dim,
};

/** Text glyphs, not emoji: one column each, so the step column never shifts. */
export const stepGlyph: Record<StepStatus, string> = {
  todo: "□",
  running: "",
  done: "✓",
  error: "✗",
  skipped: "✓",
  aborted: "✗",
  omitted: "✗",
};

export const stepColor: Record<StepStatus, string> = {
  todo: color.dim,
  running: color.text,
  done: color.ok,
  error: color.error,
  skipped: color.dim,

  // Red stays for errors: an abort is the user's choice.
  aborted: color.warn,

  // Never planned: as quiet as a step still to come.
  omitted: color.dim,
};

/** Steps: classic 6-dot braille spinner, one column, aligns with the text glyphs. */
export const STEP_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Hosts: pulsing star, padded to the width of the weather emoji. */
export const HOST_SPINNER = ["·", "✢", "✳", "∗", "✻", "✽", "✻", "∗", "✳", "✢"] as const;

export const SPINNER_INTERVAL_MS = 90;

/**
 * Emoji occupy two terminal cells, the spinner one. Padding the spinner keeps
 * the host name column aligned whatever the row shows.
 */
export const EMOJI_COLUMNS = 2;

export function padGlyph(glyph: string, isEmoji: boolean): string {
  return isEmoji ? glyph : glyph.padEnd(EMOJI_COLUMNS);
}

/** Bar of the steps carrying N units (build 4/12, wave 2/5). */
export function progressBar(done: number, total: number, width = 5): string {
  if (total <= 0) return "";
  const filled = Math.min(width, Math.round((done / total) * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function clock(t: number): string {
  const date = new Date(t);
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((unit) => String(unit).padStart(2, "0"))
    .join(":");
}
