// Signature table: a known trap must read without knowing Nix.

import { describe, expect, test } from "bun:test";
import { KnownErrors, knownError } from "./known-errors.ts";

describe("knownError", () => {
  test("the narHash mismatch names the nix-eval-jobs mismatch", () => {
    const output = [
      "error:",
      "       … while fetching the input 'git+file:///etc/nixos?ref=refs/heads/main'",
      "       error: mismatch in field 'narHash' of input '{\"__final\":true}'",
    ].join("\n");

    expect(knownError(output)).toBe(
      "nix-eval-jobs is not linked against the same Nix as the system: install the version matching nix --version",
    );
  });

  test("an unknown failure stays unexplained", () => {
    expect(knownError("error: builder for '/nix/store/x.drv' failed")).toBeUndefined();
  });
});

test("the same trap is said once per run", () => {
  const known = new KnownErrors();
  expect(known.add("boom")).toBe(true);
  expect(known.add("boom")).toBe(false);
  expect(known.all()).toEqual(["boom"]);
});
