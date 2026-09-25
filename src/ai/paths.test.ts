// Confinement of what the AI may read: pure, before any filesystem access.

import { describe, expect, test } from "bun:test";
import { confine, readableRoots, unwalked, writable } from "./paths.ts";

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

    // `dnf/` sits inside the workspace: the deepest root must decide, not the first.
    expect(refused("dnf/.git/config")).toBe("not readable: .git");
  });

  test("an empty path is refused before anything else", () => {
    expect(refused("  ")).toBe("path is empty");
  });
});

describe("writable", () => {
  const denied = (path: string, codev = true): string => {
    const result = writable(roots, path, codev);
    if (result.ok) throw new Error(`expected a refusal for ${path}`);
    return result.error;
  };

  test("a module of the consumer, and one of dnf/ in co-development", () => {
    expect(writable(roots, "usr/modules/nginx.nix", true)).toEqual({
      ok: true,
      value: "/ws/usr/modules/nginx.nix",
    });
    expect(writable(roots, "dnf/modules/service/nginx.nix", true).ok).toBe(true);
  });

  test("outside co-development dnf/ is a store path: writing it changes nothing", () => {
    expect(denied("dnf/modules/service/nginx.nix", false)).toBe(
      "not writable outside co-development: dnf/modules/service/nginx.nix",
    );
    expect(writable(roots, "usr/modules/nginx.nix", false).ok).toBe(true);
  });

  test("generated data, the declaration and every lock stay out of reach", () => {
    expect(denied("var/generated/hosts.nix")).toBe("not writable: var/generated");
    expect(denied("etc/config.yaml")).toBe("not writable: etc/config.yaml");
    expect(denied("flake.lock")).toBe("not writable: a lock is regenerated, not edited");
    expect(denied("dnf/flake.lock")).toBe("not writable: a lock is regenerated, not edited");
  });

  test("what a read refuses, a write refuses first", () => {
    expect(denied("usr/secrets/keys.yaml")).toBe("not readable: usr/secrets");
    expect(denied("/etc/shadow")).toContain("outside the readable trees");
  });
});

describe("unwalked", () => {
  test("secrets, the bin and the run traces are never walked", () => {
    expect(unwalked("usr/secrets")).toBe(true);
    expect(unwalked("usr/secrets/keys.yaml")).toBe(true);
    expect(unwalked(".trash")).toBe(true);
    expect(unwalked("var/deployments")).toBe(true);
    expect(unwalked("var/generated/hosts.nix")).toBe(false);
  });

  test("dependencies, out-links and caches are skipped at any depth", () => {
    expect(unwalked("src/app/node_modules")).toBe(true);
    expect(unwalked("usr/.git")).toBe(true);
    expect(unwalked("result")).toBe(true);
    expect(unwalked("result-gfx")).toBe(true);
    expect(unwalked(".direnv")).toBe(true);
    expect(unwalked(".Trash-1000")).toBe(true);
    expect(unwalked("usr/modules/results.nix")).toBe(false);
  });
});
