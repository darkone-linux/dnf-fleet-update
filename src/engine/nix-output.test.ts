// Parsers against line shapes recorded from nix 2.34 and nix-eval-jobs 2.34 (spike).

import { describe, expect, test } from "bun:test";
import { parseEvalJob, parseNixLog, STORE_PATH, stripAnsi } from "./nix-output.ts";

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

test("stripAnsi leaves plain text alone", () => {
  expect(stripAnsi("plain [text] 1;2m")).toBe("plain [text] 1;2m");
});
