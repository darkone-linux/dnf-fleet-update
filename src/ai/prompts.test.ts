// Prompt response shape: OpenTUI renders concise Markdown.

import { expect, test } from "bun:test";
import { systemPrompt } from "./prompts.ts";

test("analysis and repair system prompts request concise Markdown", () => {
  expect(systemPrompt(undefined)).toContain("Markdown");
  expect(systemPrompt(undefined, "repair")).toContain("Markdown");
});

test("a level reaching the code and the hosts is told to dig to the first cause", () => {
  expect(systemPrompt("active")).toContain("scope user");
  expect(systemPrompt("repair", "repair")).toContain("search_code");
  expect(systemPrompt("passive")).not.toContain("first cause");
  expect(systemPrompt(undefined)).not.toContain("first cause");
});

test("the repair session is shown the code path, after the service action", () => {
  const acting = systemPrompt("repair", "repair");
  expect(acting.indexOf("service_action")).toBeLessThan(acting.indexOf("edit_code"));
  expect(acting).toContain("validate");
  expect(acting).toContain("commit");
});

test("the review session files suggestions and touches nothing", () => {
  const review = systemPrompt("active", "suggestions");
  expect(review).toContain("You change nothing");
  expect(review).toContain("suggest");
  expect(review).not.toContain("service_action");
});
