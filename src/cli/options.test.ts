// Options: parsing, validation, resolution order, `--resume` rules.

import { describe, expect, test } from "bun:test";
import type { FleetDefaults } from "../engine/fleet.ts";
import { DEFAULT_TIMEOUTS, DEFAULTS, type RunParams, runMode } from "../model/params.ts";
import { type CliOptions, parseCli, resolveParams, resumeParams } from "./options.ts";

const NO_FLEET: FleetDefaults = { timeouts: {} };

function options(argv: string[]): CliOptions {
  const command = parseCli(argv);
  if (command.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(command)}`);
  return command.options;
}

function params(argv: string[], fleet: FleetDefaults = NO_FLEET): RunParams {
  const result = resolveParams(options(argv), fleet);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function error(argv: string[]): string {
  const command = parseCli(argv);
  if (command.kind !== "invalid") throw new Error(`expected invalid, got ${command.kind}`);
  return command.error;
}

describe("parsing", () => {
  test("help and version win over anything else", () => {
    expect(parseCli(["--bogus", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
  });

  test("defaults of the spec without any option", () => {
    const resolved = params([]);
    expect(resolved).toMatchObject({
      deploymentOrder: "hcs:gateway:server:[others]:laptop",
      criticalProfiles: "hcs:gateway:server",
      currentZoneBefore: true,
      dnfFlake: true,
      consumerFlake: true,
      dnfMessage: "chore(update): regular flake upgrade",
      consumerMessage: "chore(update): full fleet",
      interactive: true,
      ui: true,
      aiModel: "claude:opus@high",
      aiAnalysis: "none",
      aiErrorAction: "analysis",
      maxParallel: 10,
      rollbackTimeout: 600,
      pingInterval: 15,
    });
    expect(resolved.timeouts).toEqual(DEFAULT_TIMEOUTS);
    expect(runMode(resolved)).toBe("full");
  });

  test("every option is read", () => {
    const resolved = params([
      "--on=gw-*,@zone-ag",
      "--deployment-order",
      "gateway:[others]",
      "--critical-profiles",
      "gateway",
      "--no-current-zone-before",
      "--no-dnf-flake",
      "--no-flake",
      "--dnf-commit-message",
      "chore(update): dnf",
      "--commit-message",
      "chore(update): consumer",
      "--build-only",
      "--skip-test",
      "--skip-switch",
      "--no-distributed-build",
      "--stop-loss",
      "--send-report",
      "--ai-model",
      "opencode:ollama/qwen3:32b",
      "--ai-analysis",
      "active",
      "--ai-error-action",
      "repair",
      "--max-parallel",
      "3",
      "--rollback-timeout",
      "0",
    ]);
    expect(resolved).toMatchObject({
      on: "gw-*,@zone-ag",
      deploymentOrder: "gateway:[others]",
      criticalProfiles: "gateway",
      currentZoneBefore: false,
      dnfFlake: false,
      consumerFlake: false,
      dnfMessage: "chore(update): dnf",
      consumerMessage: "chore(update): consumer",
      buildOnly: true,
      skipTest: true,
      skipSwitch: true,
      distributedBuild: false,
      stopLoss: true,
      sendReport: true,
      aiModel: "opencode:ollama/qwen3:32b",
      aiAnalysis: "active",
      aiErrorAction: "repair",
      maxParallel: 3,
      rollbackTimeout: 0,
    });
    expect(runMode(resolved)).toBe("partial");
  });

  test("a partial run names its consumer commit after --on", () => {
    expect(params(["--on", "+gateway"]).consumerMessage).toBe("chore(update): +gateway");
  });

  test("--no-ui forces non-interactive; --non-interactive keeps the interface", () => {
    expect(params(["--no-ui"])).toMatchObject({ ui: false, interactive: false });
    expect(params(["--non-interactive"])).toMatchObject({ ui: true, interactive: false });
  });
});

describe("validation", () => {
  const cases: [string[], string][] = [
    [["deploy"], "unexpected argument: deploy"],
    [["--on", "gfx;reboot"], '--on: invalid term "gfx;reboot"'],
    [
      ["--deployment-order", "hcs::gateway"],
      '--deployment-order: invalid profile list "hcs::gateway"',
    ],
    [["--critical-profiles", "[others]"], '--critical-profiles: invalid profile list "[others]"'],
    [["--ai-model", "gpt:4o"], '--ai-model: expected <tool>[:<model>][@<effort>], got "gpt:4o"'],
    [["--ai-analysis", "deep"], '--ai-analysis: expected none|passive|active, got "deep"'],
    [["--ai-error-action", "fix"], '--ai-error-action: expected none|analysis|repair, got "fix"'],
    [["--max-parallel", "0"], '--max-parallel: expected an integer >= 1, got "0"'],
    [["--max-parallel", "2.5"], '--max-parallel: expected an integer >= 1, got "2.5"'],
    [["--rollback-timeout=-1"], '--rollback-timeout: expected an integer >= 0, got "-1"'],
    [["--dnf-commit-message", " "], "--dnf-commit-message: expected one non-empty line"],
    [["--commit-message", "a\nb"], "--commit-message: expected one non-empty line"],
  ];

  for (const [argv, expected] of cases) {
    test(argv.join(" ").replace("\n", "\\n"), () => expect(error(argv)).toBe(expected));
  }

  test("unknown options and missing values are rejected", () => {
    expect(error(["--bogus"])).toContain("--bogus");
    expect(error(["--max-parallel"])).toContain("--max-parallel");
  });
});

describe("resolution order", () => {
  const fleet: FleetDefaults = {
    deploymentOrder: "hcs:[others]",
    criticalProfiles: "hcs",
    timeouts: { build: 7200 },
    pingInterval: 30,
  };

  test("fleet defaults replace built-in defaults", () => {
    const resolved = params([], fleet);
    expect(resolved).toMatchObject({
      deploymentOrder: "hcs:[others]",
      criticalProfiles: "hcs",
      pingInterval: 30,
    });
    expect(resolved.timeouts).toEqual({ ...DEFAULT_TIMEOUTS, build: 7200 });
  });

  test("options replace fleet defaults", () => {
    expect(params(["--deployment-order", "gateway:hcs"], fleet).deploymentOrder).toBe(
      "gateway:hcs",
    );
  });

  test("an invalid fleet default is reported with its source", () => {
    const result = resolveParams(options([]), { timeouts: {}, criticalProfiles: "a:a" });
    expect(result).toEqual({
      ok: false,
      error: 'network.fleetUpdate.criticalProfiles: invalid profile list "a:a"',
    });
  });
});

describe("--resume", () => {
  const saved: RunParams = {
    ...params(["--on", "gw-*", "--max-parallel", "4", "--send-report", "--no-ui"]),
    deploymentOrder: "hcs:gateway",
  };

  test("keeps the saved selection and parameters, --on only filters", () => {
    const result = resumeParams(saved, options(["--resume", "--on", "gw-ag"]));
    if (!result.ok) throw new Error(result.error);

    expect(result.value.filter).toBe("gw-ag");
    expect(result.value.params).toMatchObject({
      on: "gw-*",
      deploymentOrder: "hcs:gateway",
      maxParallel: 4,
      resume: true,
    });
    expect(runMode(result.value.params)).toBe("resume");
  });

  test("flags come from this invocation, valued options override when given", () => {
    const result = resumeParams(saved, options(["--resume", "--rollback-timeout", "120"]));
    if (!result.ok) throw new Error(result.error);

    // Resumed from a terminal after an unattended run: interface and questions back.
    expect(result.value.params).toMatchObject({
      ui: true,
      interactive: true,
      sendReport: false,
      rollbackTimeout: 120,
      maxParallel: 4,
      aiModel: DEFAULTS.aiModel,
    });
  });

  test("every other option is refused, all named at once", () => {
    const result = resumeParams(
      saved,
      options([
        "--resume",
        "--no-dnf-flake",
        "--deployment-order",
        "hcs",
        "--dnf-commit-message",
        "x",
      ]),
    );
    expect(result).toEqual({
      ok: false,
      error: "--resume does not accept --deployment-order, --no-dnf-flake, --dnf-commit-message",
    });
  });
});
