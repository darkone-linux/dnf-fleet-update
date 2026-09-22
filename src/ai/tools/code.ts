// Reading the code, read-only (spec § analyse, outils `active`).
//
// The path is confined twice: `ai/paths.ts` on what was asked, the adapter on
// what it resolves to.

import { z } from "zod";
import { defineTool, fromExcerpt, type RegisteredTool } from "./types.ts";

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

export const codeTools: readonly RegisteredTool[] = [readCode];
