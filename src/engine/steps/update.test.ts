// Update step on fakes: order of the commands, commits only on changes.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../../testing/fakes.ts";
import { update } from "./update.ts";

const stdout = (line: string) => [{ stream: "stdout" as const, line }];

describe("update", () => {
  test("codev: dnf/ then consumer inputs, clean, dnf/ commit, lock realigned", async () => {
    const context = fakeRunContext({
      codev: true,
      commands: [
        { match: ["nix", "flake", "update", "dnf"] },
        { match: ["nix", "flake", "update"] },
        { match: ["just", "clean"] },
        { match: ["git", "-C", "/ws/dnf", "status"], output: stdout(" M flake.lock") },
        { match: ["git", "-C", "/ws/dnf", "rev-parse"], output: stdout("0a1b2c3d") },
        { match: ["git", "-C", "/ws/dnf"] },
        { match: ["git", "-C", "/ws", "status"] },
      ],
    });

    expect(await update(context)).toBe(true);

    const commands = context.commands.calls.map(
      (call) => call.argv.slice(0, 4).join(" ") + (call.cwd === undefined ? "" : ` @ ${call.cwd}`),
    );
    expect(commands).toEqual([
      "nix flake update @ /ws/dnf",
      "nix flake update @ /ws",
      "just clean @ /ws",
      "git -C /ws/dnf status",
      "git -C /ws/dnf add",
      "git -C /ws/dnf commit",
      "git -C /ws/dnf rev-parse",
      "nix flake update dnf @ /ws",
      "git -C /ws status",
    ]);
    expect(context.events.events).toContainEqual({
      t: 0,
      kind: "commit",
      repo: "dnf",
      rev: "0a1b2c3d",
      message: "chore(update): regular flake upgrade",
    });
    expect(feed(context.events.events)).toContain("info consumer: nothing to commit");
    expect(context.events.events.at(-1)).toEqual({
      t: 0,
      kind: "step.end",
      step: "update",
      status: "ok",
    });
    expect(context.run.logs.get("update")).toContain("$ just clean");
  });

  test("outside codev, no flake update: clean and the consumer commit only", async () => {
    const context = fakeRunContext({
      params: { consumerFlake: false, consumerMessage: "chore(update): gw-*" },
      commands: [
        { match: ["just", "clean"] },
        { match: ["git", "-C", "/ws", "status"], output: stdout("M  var/generated/hosts.nix") },
        { match: ["git", "-C", "/ws", "rev-parse"], output: stdout("9f8e7d") },
        { match: ["git", "-C", "/ws"] },
      ],
    });

    expect(await update(context)).toBe(true);

    expect(context.commands.calls.map((call) => call.argv[0])).toEqual([
      "just",
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(feed(context.events.events)).toContain("ok commit consumer chore(update): gw-*");
  });

  test("a failed clean stops the step before any commit", async () => {
    const context = fakeRunContext({
      params: { consumerFlake: false },
      commands: [
        {
          match: ["just", "clean"],
          exitCode: 1,
          output: [{ stream: "stderr", line: "statix: 2 warnings" }],
        },
      ],
    });

    expect(await update(context)).toBe(false);

    expect(feed(context.events.events)).toContain(
      "error just clean failed: exit 1: statix: 2 warnings",
    );
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
    expect(context.commands.calls).toHaveLength(1);
  });

  test("aborted now during a command: no failure reported, the step does not end", async () => {
    const context = fakeRunContext({
      params: { consumerFlake: false },
      commands: [{ match: ["just", "clean"], onRun: () => context.flow.abort("now") }],
    });

    expect(await update(context)).toBe(false);

    expect(feed(context.events.events)).toEqual(["info just clean"]);
    expect(context.events.events.some((event) => event.kind === "step.end")).toBe(false);
  });
});
