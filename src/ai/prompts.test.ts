// Prompt response shape: OpenTUI renders concise Markdown.

import { expect, test } from "bun:test";
import { systemPrompt } from "./prompts.ts";

test("analysis and repair system prompts request concise Markdown", () => {
  expect(systemPrompt(undefined)).toContain("Markdown");
  expect(systemPrompt(undefined, true)).toContain("Markdown");
});
