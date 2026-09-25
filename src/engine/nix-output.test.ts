// Parsers against line shapes recorded from nix 2.34 and nix-eval-jobs 2.34 (spike).

import { describe, expect, test } from "bun:test";
import {
  errorSummary,
  GITHUB_REF,
  parseCopyPath,
  parseEvalJob,
  parseLockedSources,
  parseNixLog,
  parsePathSize,
  STORE_PATH,
  stripAnsi,
} from "./nix-output.ts";

const DRV = "/nix/store/mfm2y1k08lnq8cfqdjiz92bjzkzfn575-nixos-system-hcs-dnf-0.1.0-26.11.drv";
const OUT = "/nix/store/jq1s2fmaq2pnv5f233sfkhmjm0lzqgcm-nixos-system-hcs-dnf-0.1.0-26.11";
const ESC = String.fromCharCode(27);

describe("nix-eval-jobs", () => {
  test("a host that evaluated", () => {
    const line = JSON.stringify({
      attr: "hcs",
      attrPath: ["hcs"],
      constituents: [],
      drvPath: DRV,
      name: "nixos-system-hcs-dnf-0.1.0-26.11",
      outputs: { out: OUT },
      system: "x86_64-linux",
    });
    expect(parseEvalJob(line)).toEqual({ kind: "ok", host: "hcs", drvPath: DRV, outPath: OUT });
  });

  test("a host that failed, colours removed", () => {
    const line = JSON.stringify({
      attr: "ms-a2",
      attrPath: ["ms-a2"],
      error: `${ESC}[31;1merror:${ESC}[0m\n       … while calling the 'throw' builtin`,
      fatal: false,
    });
    expect(parseEvalJob(line)).toEqual({
      kind: "error",
      host: "ms-a2",
      message: "error:\n       … while calling the 'throw' builtin",
      fatal: false,
    });
  });

  test("anything else is invalid, never thrown", () => {
    for (const line of [
      "",
      "not json",
      "{}",
      JSON.stringify({ attr: "x", drvPath: "/tmp/x.drv", outputs: { out: OUT } }),
    ]) {
      expect(parseEvalJob(line)).toEqual({ kind: "invalid", line });
    }
  });
});

describe("internal-json", () => {
  const nix = (payload: object) => `@nix ${JSON.stringify(payload)}`;

  test("build start and its log lines", () => {
    expect(
      parseNixLog(
        nix({
          action: "start",
          fields: [DRV, "", 1, 1],
          id: 1,
          level: 3,
          parent: 0,
          text: `building '${DRV}'`,
          type: 105,
        }),
      ),
    ).toEqual({ kind: "activity", text: `building '${DRV}'` });
    expect(
      parseNixLog(nix({ action: "result", fields: ["stdout line 1"], id: 1, type: 101 })),
    ).toEqual({
      kind: "line",
      text: "stdout line 1",
    });
    expect(
      parseNixLog(nix({ action: "result", fields: ["installPhase"], id: 1, type: 104 })),
    ).toEqual({
      kind: "phase",
      phase: "installPhase",
    });
  });

  test("substitution starts are activities", () => {
    const text = `copying path '${OUT}' from 'https://cache.example.org'`;
    expect(parseNixLog(nix({ action: "start", id: 2, level: 4, text, type: 100 }))).toEqual({
      kind: "activity",
      text,
    });
  });

  test("progress, expectations, stops and chatty messages are ignored", () => {
    const ignored = [
      nix({ action: "result", fields: [0, 0, 0, 0], id: 3, type: 105 }),
      nix({ action: "result", fields: [101, 0], id: 3, type: 106 }),
      nix({ action: "stop", id: 3 }),
      nix({ action: "start", id: 4, level: 4, text: "", type: 108 }),
      nix({ action: "start", id: 5, level: 6, text: "querying info about missing paths", type: 0 }),
      nix({ action: "msg", level: 3, msg: "this derivation will be built:" }),
      "",
    ];
    for (const line of ignored) expect(parseNixLog(line)).toBeUndefined();
  });

  test("error and warning messages, colours removed", () => {
    const error = `${ESC}[31;1merror:${ESC}[0m Cannot build '${ESC}[35;1m${DRV}${ESC}[0m'.\n       Reason: builder failed with exit code 3.`;
    expect(
      parseNixLog(
        nix({ action: "msg", column: null, file: null, level: 0, line: null, msg: error }),
      ),
    ).toEqual({
      kind: "error",
      message: `error: Cannot build '${DRV}'.\n       Reason: builder failed with exit code 3.`,
    });
    expect(
      parseNixLog(nix({ action: "msg", level: 1, msg: "warning: Git tree is dirty" })),
    ).toEqual({
      kind: "warning",
      message: "warning: Git tree is dirty",
    });
  });

  test("lines outside the format are raw, never thrown", () => {
    expect(parseNixLog("evaluation warning: C6: swap without randomEncryption")).toEqual({
      kind: "raw",
      text: "evaluation warning: C6: swap without randomEncryption",
    });
    expect(parseNixLog("@nix {broken")).toEqual({ kind: "raw", text: "@nix {broken" });
  });
});

test("store paths: real ones accepted, anything shell-meaningful refused", () => {
  expect(STORE_PATH.test(DRV)).toBe(true);
  expect(STORE_PATH.test(OUT)).toBe(true);
  for (const path of [
    "/nix/store/short-x",
    `${OUT}; reboot`,
    `${OUT}/bin/switch`,
    "/tmp/x",
    `${OUT} x`,
  ]) {
    expect({ path, ok: STORE_PATH.test(path) }).toEqual({ path, ok: false });
  }
});

describe("errorSummary", () => {
  test("a nix trace: its last error line, the cause", () => {
    const trace = [
      "error:",
      "       … while calling the 'derivationStrict' builtin",
      "         at «nix-internal»/derivation-internal.nix:37:12:",
      "",
      "       … while evaluating the option `sops.package':",
      "",
      "       (stack trace truncated; use '--show-trace' to show the full, detailed trace)",
      "",
      "       error: Go 1.25 is end-of-life and 'go_1_25' has been removed.",
    ].join("\n");

    expect(errorSummary(trace)).toBe("Go 1.25 is end-of-life and 'go_1_25' has been removed.");
  });

  test("a one-line or first-line error: that line, prefix dropped", () => {
    expect(errorSummary("error: builder for 'x.drv' failed with exit code 1;\n  last log")).toBe(
      "builder for 'x.drv' failed with exit code 1;",
    );
    expect(errorSummary("\n  cannot connect to daemon\n")).toBe("cannot connect to daemon");
  });
});

describe("copy counters", () => {
  const path = "/nix/store/00000000000000000000000000000000-outline-1.10.1";

  test("a path pushed to the host, and one the host substituted itself", () => {
    expect(parseCopyPath(`copying path '${path}' to 'ssh-ng://nix@hcs'...`)).toEqual({
      path,
      direction: "pushed",
      store: "ssh-ng://nix@hcs",
    });
    expect(parseCopyPath(`copying path '${path}' from 'https://cache.nixos.org'...`)).toEqual({
      path,
      direction: "pulled",
      store: "https://cache.nixos.org",
    });
  });

  test("any other line of nix copy, or a path that is not one", () => {
    expect(parseCopyPath("copying 67 paths...")).toBeUndefined();
    expect(parseCopyPath("error: cannot add path because it lacks a signature")).toBeUndefined();
    expect(parseCopyPath("copying path '/etc/passwd' to 'ssh-ng://nix@hcs'...")).toBeUndefined();
  });

  test("nix path-info --size: the padded columns it prints", () => {
    expect(parsePathSize(`${path}   \t     679477248`)).toBe(679_477_248);
    expect(parsePathSize("total: 12")).toBeUndefined();
    expect(parsePathSize("")).toBeUndefined();
  });
});

test("stripAnsi leaves plain text alone", () => {
  expect(stripAnsi("plain [text] 1;2m")).toBe("plain [text] 1;2m");
});

describe("flake lock", () => {
  const NIXPKGS = {
    type: "github",
    owner: "NixOS",
    repo: "nixpkgs",
    rev: "4975466d324710c576dc11ad614684e6bd8cad8e",
    narHash: "sha256-xJ+X4hBtOcAFGBOe5nAMyMUeF9foJBmIOu3NjBqBycU=",
    lastModified: 1790000000,
  };
  const REF =
    "github:NixOS/nixpkgs/4975466d324710c576dc11ad614684e6bd8cad8e?narHash=sha256-xJ%2BX4hBtOcAFGBOe5nAMyMUeF9foJBmIOu3NjBqBycU%3D";
  const metadata = (nodes: Record<string, unknown>) => ({
    locks: { version: 7, root: "root", nodes },
  });

  // `+`, `/` and `=` of the hash percent-encoded: a raw `+` would read as a space.
  test("a GitHub input becomes a locked reference with its hash", () => {
    const parsed = parseLockedSources(
      metadata({ root: { inputs: {} }, nixpkgs: { locked: NIXPKGS } }),
    );
    expect(parsed).toEqual({ ok: true, value: [{ ref: REF, narHash: NIXPKGS.narHash }] });
    expect(GITHUB_REF.test(REF)).toBe(true);
  });

  test("one source per hash, other fetchers and Enterprise hosts left to the copy", () => {
    const parsed = parseLockedSources(
      metadata({
        root: { inputs: {} },
        nixpkgs: { locked: NIXPKGS },
        nixpkgs_2: { locked: NIXPKGS },
        dnf: { locked: { type: "git", url: "file:///etc/nixos/dnf", rev: "d".repeat(40) } },
        corp: {
          locked: { ...NIXPKGS, host: "git.example.org", narHash: `sha256-${"A".repeat(43)}=` },
        },
      }),
    );
    expect(parsed.ok && parsed.value.map((source) => source.ref)).toEqual([REF]);
  });

  test("an output that is no lock fails", () => {
    expect(parseLockedSources({ description: "no locks" }).ok).toBe(false);
  });
});
