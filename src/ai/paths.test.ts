// Confinement of what the AI may read: pure, before any filesystem access.

import { describe, expect, test } from "bun:test";
import { confine, readableRoots } from "./paths.ts";

const roots = readableRoots("/ws");

function refused(path: string): string {
  const result = confine(roots, path);
  if (result.ok) throw new Error(`expected a refusal for ${path}`);
  return result.error;
}

describe("confine", () => {
  test("a relative path is resolved against the workspace", () => {
    expect(confine(roots, "usr/modules/nginx.nix")).toEqual({
      ok: true,
      value: "/ws/usr/modules/nginx.nix",
    });
  });

  test("dnf/ beside the workspace is readable", () => {
    expect(confine(roots, "dnf/modules/admin/fleet-update.nix")).toEqual({
      ok: true,
      value: "/ws/dnf/modules/admin/fleet-update.nix",
    });
  });

  test("an absolute path inside a root is kept", () => {
    expect(confine(roots, "/ws/flake.nix")).toEqual({ ok: true, value: "/ws/flake.nix" });
  });

  test("outside every root, whether climbing or absolute", () => {
    expect(refused("/etc/shadow")).toContain("outside the readable trees");
    expect(refused("../../etc/shadow")).toContain("outside the readable trees");
    expect(refused("usr/../../etc/shadow")).toContain("outside the readable trees");
  });

  test("a sibling whose name merely starts like the root is outside", () => {
    expect(refused("/ws-other/flake.nix")).toContain("outside the readable trees");
  });

  test("secrets, the recycle bin and git internals are never readable", () => {
    expect(refused("usr/secrets/keys.yaml")).toBe("not readable: usr/secrets");
    expect(refused(".trash/old.nix")).toBe("not readable: .trash");
    expect(refused(".git/config")).toBe("not readable: .git");
  });

  test("an empty path is refused before anything else", () => {
    expect(refused("  ")).toBe("path is empty");
  });
});
