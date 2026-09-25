// Prompt response shape: OpenTUI renders concise Markdown.

import { expect, test } from "bun:test";
import { systemPrompt } from "./prompts.ts";

test("analysis and repair system prompts request concise Markdown", () => {
  expect(systemPrompt(undefined)).toContain("Markdown");
  expect(systemPrompt(undefined, true)).toContain("Markdown");
});

test("a level reaching the code and the hosts is told to dig to the first cause", () => {
  expect(systemPrompt("active")).toContain("scope user");
  expect(systemPrompt("repair", true)).toContain("search_code");
  expect(systemPrompt("passive")).not.toContain("first cause");
  expect(systemPrompt(undefined)).not.toContain("first cause");
});

test("the repair session is shown the code path, after the service action", () => {
  const acting = systemPrompt("repair", true);
  expect(acting.indexOf("service_action")).toBeLessThan(acting.indexOf("edit_code"));
  expect(acting).toContain("validate");
  expect(acting).toContain("commit");
});
