// Signature table: a known trap must read without knowing Nix, and say what
// the run may do about it.

import { describe, expect, test } from "bun:test";
import { KnownErrors, knownError } from "./known-errors.ts";

describe("knownError", () => {
  test("the narHash mismatch names the nix-eval-jobs mismatch, and stops the run", () => {
    const output = [
      "error:",
      "       … while fetching the input 'git+file:///etc/nixos?ref=refs/heads/main'",
      "       error: mismatch in field 'narHash' of input '{\"__final\":true}'",
    ].join("\n");

    expect(knownError(output)).toEqual({
      message:
        "nix-eval-jobs is not linked against the same Nix as the system: install the version matching nix --version",
      fix: { kind: "stop" },
    });
  });

  test("the missing signature names the trusted-users setting, and stops the run", () => {
    const output =
      "error: cannot add path '/nix/store/0gpc4z-element-web-wrapped-1.12.26' because it lacks a signature by a trusted key";

    expect(knownError(output)).toEqual({
      message:
        "the deploy user is not trusted on that host: add nix to its nix.settings.trusted-users",
      fix: { kind: "stop" },
    });
  });

  test("an unknown failure stays unexplained", () => {
    expect(knownError("error: builder for '/nix/store/x.drv' failed")).toBeUndefined();
  });
});

test("the table of a run can be replaced: a consumer signature is one more entry", () => {
  const known = new KnownErrors([
    { match: /connection reset/, message: "the link dropped", fix: { kind: "retry", max: 2 } },
  ]);

  expect(known.match("error: connection reset by peer")).toEqual({
    message: "the link dropped",
    fix: { kind: "retry", max: 2 },
  });

  // The built-in entries are not behind it: the table given is the table used.
  expect(known.match("error: mismatch in field 'narHash'")).toBeUndefined();
  expect(new KnownErrors().match("error: mismatch in field 'narHash'")?.fix).toEqual({
    kind: "stop",
  });
});

test("the same trap is said once per run", () => {
  const known = new KnownErrors();
  expect(known.add("boom")).toBe(true);
  expect(known.add("boom")).toBe(false);
  expect(known.all()).toEqual(["boom"]);
});
