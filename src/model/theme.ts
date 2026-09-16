// Palette, glyphs and spinner.
//
// Single source for the interface: `--no-ui` renders the same events without
// any of it.

import type { HostState, Level } from "./events.ts";
import type { StepStatus } from "./state.ts";

export const color = {
  host: "#22d3ee",
  ai: "#d946ef",
  ok: "#4ade80",
  error: "#f87171",
  warn: "#fbbf24",
  dim: "#6b7280",
  text: "#e5e7eb",
  border: "#374151",
  activeBorder: "#22d3ee",
  highlight: "#1f2937",
} as const;

export const levelColor: Record<Level, string> = {
  info: color.text,
  ok: color.ok,
  warn: color.warn,
  error: color.error,
};

/**
 * Weather metaphor: the run clears up as hosts land, `☀️` being a deployed
 * host. Active states take the spinner instead.
 */
export const hostGlyph: Record<HostState, string> = {
  pending: "☁️",
  building: "",
  copying: "",
  testing: "",
  switching: "",
  built: "🌥️",
  tested: "🌤️",
  deployed: "☀️",
  failed: "🌧️",
  offline: "💤",
  excluded: "",
};

/** A service that did not start is a lighter failure than a broken host. */
export const serviceFailureGlyph = "🌦️";

export const hostStateColor: Record<HostState, string> = {
  pending: color.dim,
  building: color.text,
  copying: color.text,
  testing: color.text,
  switching: color.text,
  built: color.text,
  tested: color.text,
  deployed: color.ok,
  failed: color.error,
  offline: color.dim,
  excluded: color.dim,
};

export const stepGlyph: Record<StepStatus, string> = {
  todo: "▢",
  running: "",
  done: "✅",
  error: "❌",
  skipped: "✅",
};

export const stepColor: Record<StepStatus, string> = {
  todo: color.dim,
  running: color.text,
  done: color.ok,
  error: color.error,
  skipped: color.dim,
};

/** Pulsing star, Claude Code style. */
export const SPINNER_FRAMES = ["·", "✢", "✳", "∗", "✻", "✽", "✻", "∗", "✳", "✢"] as const;

export const SPINNER_INTERVAL_MS = 90;

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
