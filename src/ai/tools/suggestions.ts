// Improvement suggestions, filed by the end-of-run review (spec § analyse,
// Suggestions d'amélioration).
//
// Published at `active`, refused outside that review: a host analysis
// explains, it does not file.

import { z } from "zod";
import { SLUG, SUGGESTIONS_DIR } from "../suggestions.ts";
import { defineTool, type RegisteredTool } from "./types.ts";

/** A body is a note for a human, not a report. */
const MAX_BODY_LINES = 60;

const knownSuggestions = defineTool({
  name: "known_suggestions",
  level: "active",
  description: `Suggestions already filed by earlier runs, in ${SUGGESTIONS_DIR}/: slug, status (open, or ignored by the operator), runs seen, last run, title. A body is read with read_code.`,
  input: z.strictObject({}),
  summary: () => "reads the known suggestions",
  run: async (context) => {
    const known = await context.knownSuggestions();
    if (known.length === 0) return { lines: ["no suggestion filed yet"] };
    return {
      lines: known.map(
        (entry) =>
          `${entry.slug} | ${entry.status} | ${entry.runs} runs, last ${entry.lastSeen ?? "unknown"} | ${entry.title}`,
      ),
    };
  },
});

const suggest = defineTool({
  name: "suggest",
  level: "active",
  description:
    "File one improvement suggestion for a human: a new slug creates its file; a known slug (open or ignored) only marks it seen by this run, its text kept. Changes neither the code nor the fleet.",
  input: z.strictObject({
    slug: z
      .string()
      .regex(SLUG)
      .describe("file name, kebab-case, 3 to 60 characters, e.g. gdm-greeter-uid-shift"),
    title: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\n]*$/)
      .describe("one line"),
    body: z
      .string()
      .min(1)
      .refine((body) => body.split("\n").length <= MAX_BODY_LINES, {
        message: `${MAX_BODY_LINES} lines at most`,
      })
      .describe("Markdown: what, where (path:line), why, and the change proposed"),
  }),
  summary: (args) => `files the suggestion ${args.slug}`,
  run: async (context, args) => ({
    lines: [await context.suggest(args.slug, args.title.trim(), args.body)],
  }),
});

export const suggestionTools: readonly RegisteredTool[] = [knownSuggestions, suggest];
