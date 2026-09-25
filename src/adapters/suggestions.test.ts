// Suggestion files on a temp dir.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectorySuggestions } from "./suggestions.ts";

const temp = mkdtempSync(join(tmpdir(), "fleet-update-suggestions-"));

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("DirectorySuggestions", () => {
  test("nothing filed yet: no directory, no file, no error", async () => {
    const files = new DirectorySuggestions(join(temp, "absent"));
    expect(await files.list()).toEqual([]);
    expect(await files.read("gdm-greeter-uid")).toBeUndefined();
  });

  test("written with its directory, listed by slug, read back", async () => {
    const dir = join(temp, "deployments", "suggestions");
    const files = new DirectorySuggestions(dir);
    expect(await files.write("zz-last", "# Z\n")).toEqual({ ok: true, value: undefined });
    expect(await files.write("aa-first", "# A\n")).toEqual({ ok: true, value: undefined });
    writeFileSync(join(dir, "notes.txt"), "not a suggestion");

    expect(await files.list()).toEqual([
      { slug: "aa-first", text: "# A\n" },
      { slug: "zz-last", text: "# Z\n" },
    ]);
    expect(readFileSync(join(dir, "aa-first.md"), "utf8")).toBe("# A\n");
  });

  test("a name that could leave the directory is a bug, never a path", async () => {
    const files = new DirectorySuggestions(join(temp, "unsafe"));
    mkdirSync(join(temp, "unsafe"), { recursive: true });
    expect(files.write("../escape", "x")).rejects.toThrow("unsafe suggestion name");
  });
});
