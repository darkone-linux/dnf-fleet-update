// Commit message gate, as the hook and CI run it.
//
// `just commit` sends one message to every repository of the workspace: a
// drift from the framework's gate would refuse here what dnf/ accepts.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = new URL("../scripts/check-commit-msg.sh", import.meta.url).pathname;
const UPSTREAM = new URL("../../../dnf/scripts/check-commit-msg.sh", import.meta.url).pathname;

/** Hook mode: the editor buffer arrives as a file, here stdin. */
function check(message: string) {
  const proc = Bun.spawnSync(["bash", SCRIPT, "/dev/stdin"], {
    stdin: Buffer.from(message),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, stderr: proc.stderr.toString() };
}

describe("accepted", () => {
  test.each([
    "feat(engine): plan waves by profile",
    "fix(ui): keep the host band on resize",
    "feat(cli)!: drop --no-consumer-flake",
    "chore(deps): opentui 0.6.0",
  ])("%s", (message) => {
    expect(check(`${message}\n`).ok).toBe(true);
  });

  test("comments and the `commit -v` diff are not part of the message", () => {
    const buffer = [
      "test(model): fold unknown events",
      "# Please enter the commit message",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
    ].join("\n");

    expect(check(buffer).ok).toBe(true);
  });
});

describe("refused", () => {
  test.each([
    ["type outside the closed list", "feature(engine): plan waves", "expected <type>(<scope>)"],
    ["missing scope", "feat: plan waves", "expected <type>(<scope>)"],
    ["scope used as type", "engine(waves): plan", "expected <type>(<scope>)"],
    ["second line", "feat(engine): plan waves\n\nbody", "more than one line"],
    ["over 80 chars", `feat(engine): ${"x".repeat(70)}`, "over 80 chars"],
  ])("%s", (_reason, message, expected) => {
    const result = check(message);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(expected);
  });
});

/** From `set -euo pipefail` down: headers differ, the rules must not. */
function body(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.slice(text.indexOf("set -euo pipefail"));
}

test.skipIf(!existsSync(UPSTREAM))("mirrors the framework gate (co-development only)", () => {
  expect(body(SCRIPT)).toBe(body(UPSTREAM));
});
