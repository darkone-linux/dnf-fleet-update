// `--no-ui` text output (spec § Mode sans interface): the feed of the
// interface, without colours. Command output stays in `logs/`.

import { aiLabel } from "../model/ai-labels.ts";
import { type Event, STEP_LABELS } from "../model/events.ts";
import { clock } from "../model/theme.ts";

/** Under the AI title, as in the interface. */
const AI_INDENT = "  ";

/** Lines one event adds to stdout; none for what the feed does not show. */
export function textLines(event: Event): string[] {
  const time = clock(event.t);
  switch (event.kind) {
    case "step.start":
      return [STEP_LABELS[event.step]];
    case "wave.start":
      return [`${time}  wave ${event.index}/${event.total}: ${event.hosts.join(", ")}`];
    case "log":
      return [`${time}  ${event.host === undefined ? "" : `${event.host} · `}${event.message}`];
    case "ai":
      return [
        `${time}  ${aiLabel(event.message)}`,
        ...(event.detail ?? []).map((line) => AI_INDENT + line),
      ];
    case "ai.line":
      return [AI_INDENT + event.line];
    case "run.end":
      return event.report ?? [];
    default:
      return [];
  }
}
