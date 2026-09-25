// Operator context appears in every AI user prompt, never in tool permissions.

import { expect, test } from "bun:test";
import type { PersistedHost } from "../model/persist.ts";
import { initialPersisted } from "../model/persist.ts";
import { freePrompt, hostPrompt, repairPrompt, runPrompt, systemPrompt } from "./prompts.ts";

const HOST: PersistedHost = {
  name: "hcs",
  profile: "server",
  zone: "ag",
  state: "failed",
  status: "failed",
};

test("all user prompts include non-empty operator context", () => {
  const state = initialPersisted();
  const context = "Rédiger en français, de façon concise.";
  const prompts = [
    hostPrompt(state, HOST, context),
    runPrompt(state, context),
    repairPrompt(state, HOST, [], context),
    freePrompt(state, "What happened?", context),
  ];

  for (const prompt of prompts) {
    expect(prompt).toContain(`Operator context:\n${context}`);
  }
});

test("empty operator context adds no section", () => {
  expect(freePrompt(initialPersisted(), "What happened?", "  ")).not.toContain("Operator context:");
});

test("operator guidance does not change the system's safety boundaries", () => {
  expect(systemPrompt(undefined)).toContain("not permission to exceed these boundaries");
});

test("the repair prompt says which trees an edit may reach", () => {
  const run = {
    version: "0",
    selection: "all",
    mode: "full" as const,
    aiModel: "claude",
    maxParallel: 1,
  };
  const codev = { ...initialPersisted(), run: { ...run, codev: true } };
  const consumer = { ...initialPersisted(), run: { ...run, codev: false } };

  expect(repairPrompt(codev, HOST, [])).toContain("framework under dnf/ may both be edited");
  expect(repairPrompt(consumer, HOST, [])).toContain("only the project may be edited");
  expect(repairPrompt(consumer, HOST, [])).toContain("a fix of the code");
});
