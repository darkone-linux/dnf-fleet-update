// Confinement of the readable trees, on real files: a symlink out is an escape.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwalked } from "../ai/paths.ts";
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

describe("DirectorySources walks", () => {
  // A workspace with a framework linked beside it, as outside co-development.
  const ws = join(temp, "walk", "ws");
  const store = join(temp, "walk", "store-dnf");
  mkdirSync(join(ws, "usr", "modules"), { recursive: true });
  mkdirSync(join(ws, "src", "generator", ".git"), { recursive: true });
  mkdirSync(join(ws, "var", "deployments", "run"), { recursive: true });
  mkdirSync(join(store, "home", "modules"), { recursive: true });
  writeFileSync(
    join(ws, "usr", "modules", "music.nix"),
    "{\n  services.MpdRis2.enable = true;\n}\n",
  );
  writeFileSync(join(ws, "src", "generator", "main.rs"), "// mpdris2\n");
  writeFileSync(join(ws, "var", "deployments", "run", "report.md"), "mpdris2\n");
  writeFileSync(
    join(ws, "usr", "blob.bin"),
    Buffer.from([0x6d, 0x70, 0x64, 0, 0x72, 0x69, 0x73, 0x32]),
  );
  writeFileSync(join(store, "home", "modules", "music.nix"), "services.mpdris2 = {};\n");
  symlinkSync(store, join(ws, "dnf"));
  symlinkSync(join(ws, "usr", "modules"), join(ws, "usr", "loop"));

  const walker = new DirectorySources([ws, join(ws, "dnf")], unwalked);

  test("search: both trees, dnf/ named as the workspace sees it, case ignored", async () => {
    expect(await walker.search("mpdris2", ws, 100)).toEqual({
      ok: true,
      value: {
        lines: [
          "dnf/home/modules/music.nix:1: services.mpdris2 = {};",
          "usr/modules/music.nix:2: services.MpdRis2.enable = true;",
        ],
        dropped: 0,
      },
    });
  });

  test("search: nested repositories, run traces, binaries and links are left out", async () => {
    const found = await walker.search("mpd", ws, 100);
    const paths = found.ok ? found.value.lines.map((line) => line.split(":")[0]) : [];
    expect(paths).toEqual(["dnf/home/modules/music.nix", "usr/modules/music.nix"]);
  });

  test("search: capped, the rest counted", async () => {
    expect(await walker.search("mpdris2", ws, 1)).toEqual({
      ok: true,
      value: { lines: ["dnf/home/modules/music.nix:1: services.mpdris2 = {};"], dropped: 1 },
    });
  });

  test("search: one file, or a sub-directory of the framework", async () => {
    const one = await walker.search("enable", join(ws, "usr", "modules", "music.nix"), 10);
    expect(one.ok && one.value.lines).toEqual([
      "usr/modules/music.nix:2: services.MpdRis2.enable = true;",
    ]);
    const framework = await walker.search("services", join(ws, "dnf", "home"), 10);
    expect(framework.ok && framework.value.lines).toEqual([
      "dnf/home/modules/music.nix:1: services.mpdris2 = {};",
    ]);
  });

  test("list: one level, the framework link shown as a directory", async () => {
    expect(await walker.list(ws, 100)).toEqual({
      ok: true,
      value: { lines: ["dnf/", "src/", "usr/", "var/"], dropped: 0 },
    });
    expect(await walker.list(join(ws, "src"), 100)).toEqual({
      ok: true,
      value: { lines: [], dropped: 0 },
    });
    expect(await walker.list(join(ws, "usr"), 1)).toEqual({
      ok: true,
      value: { lines: ["blob.bin"], dropped: 1 },
    });
  });

  test("list: a file is not a directory, and the walk never leaves the roots", async () => {
    const file = join(ws, "usr", "modules", "music.nix");
    expect(await walker.list(file, 10)).toEqual({ ok: false, error: `not a directory: ${file}` });
    expect((await walker.search("x", outside, 10)).ok).toBe(false);
  });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));
