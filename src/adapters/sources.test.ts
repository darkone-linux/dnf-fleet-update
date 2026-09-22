// Confinement of the readable trees, on real files: a symlink out is an escape.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectorySources } from "./sources.ts";

const temp = mkdtempSync(join(tmpdir(), "fleet-update-sources-"));
const workspace = join(temp, "workspace");
const outside = join(temp, "outside");

mkdirSync(join(workspace, "usr"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(workspace, "usr", "nginx.nix"), "{ services.nginx.enable = true; }\n");
writeFileSync(join(outside, "secret.txt"), "not yours\n");
symlinkSync(join(outside, "secret.txt"), join(workspace, "escape.nix"));

const sources = new DirectorySources([workspace]);

describe("DirectorySources", () => {
  test("reads a file of a root", async () => {
    const result = await sources.read(join(workspace, "usr", "nginx.nix"), 10);
    expect(result).toEqual({
      ok: true,
      value: { lines: ["{ services.nginx.enable = true; }"], dropped: 0 },
    });
  });

  test("refuses a path outside every root", async () => {
    const result = await sources.read(join(outside, "secret.txt"), 10);
    expect(result.ok).toBe(false);
  });

  test("refuses a symlink leading out of a root: the resolved path decides", async () => {
    const result = await sources.read(join(workspace, "escape.nix"), 10);
    expect(result).toEqual({
      ok: false,
      error: `outside the readable trees: ${join(workspace, "escape.nix")}`,
    });
  });

  test("refuses `..` climbing out of a root", async () => {
    const result = await sources.read(join(workspace, "..", "outside", "secret.txt"), 10);
    expect(result.ok).toBe(false);
  });

  test("a missing file is refused, not empty", async () => {
    const result = await sources.read(join(workspace, "absent.nix"), 10);
    expect(result).toEqual({ ok: false, error: `no such file: ${join(workspace, "absent.nix")}` });
  });
});

describe("DirectorySources.write", () => {
  test("replaces a file of a root, and creates one that does not exist yet", async () => {
    const existing = join(workspace, "usr", "nginx.nix");
    expect(await sources.write(existing, "{ }\n")).toEqual({ ok: true, value: undefined });
    expect(readFileSync(existing, "utf8")).toBe("{ }\n");

    const fresh = join(workspace, "usr", "outline.nix");
    expect((await sources.write(fresh, "{ new = true; }\n")).ok).toBe(true);
    expect(readFileSync(fresh, "utf8")).toBe("{ new = true; }\n");
  });

  test("refuses to write outside a root, through a symlinked parent too", async () => {
    expect((await sources.write(join(outside, "planted.nix"), "x")).ok).toBe(false);

    symlinkSync(outside, join(workspace, "out-link"));
    const through = join(workspace, "out-link", "planted.nix");
    expect(await sources.write(through, "x")).toEqual({
      ok: false,
      error: `outside the readable trees: ${through}`,
    });
  });

  test("a directory that does not exist is said, not created blindly", async () => {
    const result = await sources.write(join(workspace, "nowhere", "deep", "x.nix"), "x");
    expect(result.ok).toBe(false);
  });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));
