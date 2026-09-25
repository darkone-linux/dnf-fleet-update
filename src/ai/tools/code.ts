// Reading the code, read-only (spec § analyse, outils `active`).
//
// The path is confined twice: `ai/paths.ts` on what was asked, the adapter on
// what it resolves to.

import { z } from "zod";
import { defineTool, fromExcerpt, type RegisteredTool } from "./types.ts";

/** Search hits handed back at most (spec § analyse, Trouver le code). */
const SEARCH_HITS = 100;

const readCode = defineTool({
  name: "read_code",
  level: "active",
  description:
    "Read a file of the deployment sources: the consumer project, or dnf/ beside it. Read-only, and confined to those two trees.",
  input: z.strictObject({
    path: z.string().describe("path relative to the consumer project, e.g. usr/modules/nginx.nix"),
    lines: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("lines kept from the top of the file; defaults to the run's own bound"),
  }),
  summary: (args) => `reads ${args.path}`,
  run: async (context, args) =>
    fromExcerpt(await context.readSource(args.path, args.lines ?? context.params.ai.sourceLines)),
});

const searchCode = defineTool({
  name: "search_code",
  level: "active",
  description:
    "Find where something is written in the deployment sources (the consumer project, and dnf/ beside it): every line holding a literal text, case ignored, as path:line: text. Use it to find the module behind a unit, an option or a package before reading it.",
  input: z.strictObject({
    pattern: z
      .string()
      .min(1)
      .describe("literal text, not a regular expression, e.g. services.mpdris2"),
    path: z
      .string()
      .optional()
      .describe(
        "directory or file to search, relative to the consumer project; defaults to both trees",
      ),
  }),
  summary: (args) => `searches ${args.path ?? "the code"} for "${args.pattern}"`,
  run: async (context, args) => {
    const found = await context.searchSource(args.pattern, args.path ?? ".", SEARCH_HITS);
    if (found.lines.length === 0) return { lines: [`no line holds "${args.pattern}"`] };
    return fromExcerpt(found);
  },
});

const listCode = defineTool({
  name: "list_code",
  level: "active",
  description:
    "List one directory of the deployment sources, a trailing / marking a sub-directory. Defaults to the consumer project root, where dnf/ is the framework.",
  input: z.strictObject({
    path: z
      .string()
      .optional()
      .describe("directory relative to the consumer project, e.g. dnf/home/modules"),
  }),
  summary: (args) => `lists ${args.path ?? "the project root"}`,
  run: async (context, args) =>
    fromExcerpt(await context.listSource(args.path ?? ".", context.params.ai.sourceLines)),
});

export const codeTools: readonly RegisteredTool[] = [readCode, searchCode, listCode];
