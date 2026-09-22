// Bounded reads on temp files: exact tail, exact head, exact count of what was cut.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headLines, tailLines } from "./tail.ts";

const temp = mkdtempSync(join(tmpdir(), "fleet-update-tail-"));
let count = 0;

afterAll(() => rmSync(temp, { recursive: true, force: true }));

function file(lines: readonly string[]): string {
  const path = join(temp, `log-${++count}.log`);
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return path;
}

const many = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);

describe("tailLines", () => {
  test("keeps the last lines and counts the rest", async () => {
    expect(await tailLines(file(many), 3)).toEqual({
      lines: ["line 498", "line 499", "line 500"],
      dropped: 497,
    });
  });

  test("a short file is whole, nothing dropped", async () => {
    expect(await tailLines(file(["only"]), 10)).toEqual({ lines: ["only"], dropped: 0 });
  });

  test("a missing file reads empty: the step that writes it never ran", async () => {
    expect(await tailLines(join(temp, "absent.log"), 10)).toEqual({ lines: [], dropped: 0 });
  });

  test("asking for nothing reads nothing", async () => {
    expect(await tailLines(file(many), 0)).toEqual({ lines: [], dropped: 0 });
  });
});

describe("headLines", () => {
  test("keeps the first lines and counts the rest", async () => {
    expect(await headLines(file(many), 2)).toEqual({
      lines: ["line 1", "line 2"],
      dropped: 498,
    });
  });

  test("a missing file is undefined, not empty: the caller says why", async () => {
    expect(await headLines(join(temp, "absent.nix"), 10)).toBeUndefined();
  });
});
