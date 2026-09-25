// Improvement suggestions kept across runs (spec § analyse, Suggestions
// d'amélioration): `var/deployments/suggestions/<slug>.md`, one per finding.
//
// Pure: the file format is read and written here. A file already there is
// never rewritten, only its `Last seen` and `Runs` lines move.

/** File name of a suggestion: kebab-case, 3 to 60 characters. */
export const SLUG = /^(?=.{3,60}$)[a-z0-9]+(-[a-z0-9]+)*$/;

/** Where the files live, relative to the workspace: said to the model and the report. */
export const SUGGESTIONS_DIR = "var/deployments/suggestions";

export const suggestionPath = (slug: string): string => `${SUGGESTIONS_DIR}/${slug}.md`;

/** `ignored`: the operator silenced it. Anything else a human writes reads as `open`. */
export type SuggestionStatus = "open" | "ignored";

export interface Suggestion {
  slug: string;
  title: string;
  status: SuggestionStatus;
  firstSeen?: string;
  lastSeen?: string;
  runs: number;
}

const field = (text: string, name: string): string | undefined =>
  new RegExp(`^- ${name}: *(.*?) *$`, "im").exec(text)?.[1];

/** What the header of a file says; a file a human reshaped still reads, with defaults. */
export function parseSuggestion(slug: string, text: string): Suggestion {
  const title = /^# +(.+?) *$/m.exec(text)?.[1] ?? slug;
  const status = field(text, "Status")?.toLowerCase() === "ignored" ? "ignored" : "open";
  const runs = Number.parseInt(field(text, "Runs") ?? "", 10);
  const firstSeen = field(text, "First seen");
  const lastSeen = field(text, "Last seen");
  return {
    slug,
    title,
    status,
    ...(firstSeen === undefined ? {} : { firstSeen }),
    ...(lastSeen === undefined ? {} : { lastSeen }),
    runs: Number.isNaN(runs) ? 1 : runs,
  };
}

/** A new file: the header the operator edits, then the model's text. */
export function renderSuggestion(title: string, body: string, runId: string): string {
  return [
    `# ${title}`,
    "",
    "- Status: open",
    `- First seen: ${runId}`,
    `- Last seen: ${runId}`,
    "- Runs: 1",
    "",
    body.trim(),
    "",
  ].join("\n");
}

/** Seen once more: `Last seen` and `Runs` move, every other byte stays. */
export function markSeen(text: string, runId: string): string {
  const runs = parseSuggestion("", text).runs + 1;
  return text
    .replace(/^(- Last seen:).*$/im, `$1 ${runId}`)
    .replace(/^(- Runs:).*$/im, `$1 ${runs}`);
}

/** One suggestion filed or seen again by this run, for the report. */
export interface SuggestionEntry {
  slug: string;
  title: string;
  status: SuggestionStatus;
  runs: number;

  /** Filed by this run, rather than met again. */
  fresh: boolean;
}

/**
 * What the run filed, and whether the review is underway: the two tools
 * refuse outside it (spec § Suggestions, Outils).
 */
export class AiSuggestions {
  reviewing = false;
  private readonly entries: SuggestionEntry[] = [];

  add(entry: SuggestionEntry): void {
    this.entries.push(entry);
  }

  has(slug: string): boolean {
    return this.entries.some((entry) => entry.slug === slug);
  }

  all(): readonly SuggestionEntry[] {
    return this.entries;
  }
}
