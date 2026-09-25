// Real `SourceFiles`: the trees the AI may read, and nothing else.
//
// Confinement is checked twice — on the asked path (pure, `ai/paths.ts`) and
// here on the **resolved** one: a symlink leading out of a root is an escape,
// not a shortcut.

import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Excerpt, SourceFiles } from "../engine/ports.ts";
import { fail, ok, type Result } from "../model/result.ts";
import { headLines } from "./tail.ts";

/** Past this a file is data, not source: never searched. */
const MAX_BYTES = 1024 * 1024;

/** Leading bytes checked for a NUL: enough to tell a binary from a text. */
const SNIFF_BYTES = 8000;

/** A search hit is one line of the answer: past this it is cut. */
const LINE_CHARS = 200;

/** `true`: a walk leaves the entry out, by its path relative to the root holding it. */
export type Unwalked = (relative: string) => boolean;

interface Entry {
  name: string;

  /** Resolved: another root's link is followed to where it leads. */
  path: string;
  directory: boolean;
}

/** Strictly inside `root`, or the root itself: compared segment-wise, never by prefix alone. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Text of a source file; `undefined` for a binary or an oversized one. */
async function readText(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).size > MAX_BYTES) return undefined;
    const bytes = await readFile(path);
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
    return bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

export class DirectorySources implements SourceFiles {
  private readonly asked: string[];
  private readonly unwalked: Unwalked;
  private resolved?: Promise<string[]>;

  /**
   * Roots the AI may read: the consumer workspace, and `dnf/` beside it.
   * `unwalked`: what a search or a listing leaves out (`ai/paths.ts`).
   */
  constructor(roots: readonly string[], unwalked: Unwalked = () => false) {
    this.asked = roots.map((root) => resolve(root));
    this.unwalked = unwalked;
  }

  // Outside codev `dnf/` is a store path reached through a symlink, so the
  // roots are resolved too: otherwise every read under it would read as an escape.
  private roots(): Promise<string[]> {
    this.resolved ??= Promise.all(this.asked.map((root) => realpath(root).catch(() => root)));
    return this.resolved;
  }

  /** Resolved path, refused once it leaves every root. */
  private async inside(path: string): Promise<Result<string>> {
    let target: string;
    try {
      target = await realpath(resolve(path));
    } catch {
      return fail(`no such file: ${path}`);
    }
    const roots = await this.roots();
    if (!roots.some((root) => within(root, target)))
      return fail(`outside the readable trees: ${path}`);
    return ok(target);
  }

  /** Most specific root holding `path`: `dnf/` sits inside the workspace in codev. */
  private holder(roots: readonly string[], path: string): number {
    let best = -1;
    for (const [index, root] of roots.entries()) {
      if (within(root, path) && (roots[best]?.length ?? -1) < root.length) best = index;
    }
    return best;
  }

  /** As the AI names it: relative to the workspace, `dnf/…` wherever the store put it. */
  private shown(roots: readonly string[], path: string): string {
    const index = this.holder(roots, path);
    const root = roots[index];
    const asked = this.asked[index];
    if (root === undefined || asked === undefined) return path;
    return relative(this.asked[0] ?? "", join(asked, relative(root, path)));
  }

  /** What a walk sees of a directory: sorted, filtered, another root's link followed. */
  private async entries(dir: string, roots: readonly string[]): Promise<Entry[]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const kept: Entry[] = [];
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, dirent.name);

      // `dnf/` in the workspace: its own root, a link or a git tree alike.
      const other = roots.findIndex(
        (root, index) => index > 0 && (root === path || this.asked[index] === path),
      );
      const root = roots[other];
      if (root !== undefined) {
        kept.push({ name: dirent.name, path: root, directory: true });
        continue;
      }
      if (dirent.isSymbolicLink()) continue;
      const base = roots[this.holder(roots, path)] ?? dir;
      if (this.unwalked(relative(base, path))) continue;
      if (dirent.isDirectory()) {
        // A nested repository (`src/*`, `doc/`) is not the deployment.
        if (await exists(join(path, ".git"))) continue;
        kept.push({ name: dirent.name, path, directory: true });
      } else if (dirent.isFile()) {
        kept.push({ name: dirent.name, path, directory: false });
      }
    }
    return kept;
  }

  async read(path: string, lines: number): Promise<Result<Excerpt>> {
    const target = await this.inside(path);
    if (!target.ok) return target;
    const excerpt = await headLines(target.value, lines);
    return excerpt === undefined ? fail(`cannot read: ${path}`) : ok(excerpt);
  }

  async text(path: string): Promise<Result<string>> {
    const target = await this.inside(path);
    if (!target.ok) return target;
    const text = await readText(target.value);
    return text === undefined ? fail(`not a text file under 1 MiB: ${path}`) : ok(text);
  }

  async list(path: string, limit: number): Promise<Result<Excerpt>> {
    const target = await this.inside(path);
    if (!target.ok) return target;
    if (!(await isDirectory(target.value))) return fail(`not a directory: ${path}`);

    const roots = await this.roots();
    const names = (await this.entries(target.value, roots)).map((entry) =>
      entry.directory ? `${entry.name}/` : entry.name,
    );
    const kept = names.slice(0, Math.max(0, limit));
    return ok({ lines: kept, dropped: names.length - kept.length });
  }

  async search(pattern: string, path: string, limit: number): Promise<Result<Excerpt>> {
    const target = await this.inside(path);
    if (!target.ok) return target;

    const roots = await this.roots();
    const needle = pattern.toLowerCase();
    const hits: string[] = [];
    let dropped = 0;
    const visit = async (at: string, directory: boolean): Promise<void> => {
      if (directory) {
        for (const entry of await this.entries(at, roots)) await visit(entry.path, entry.directory);
        return;
      }
      const text = await readText(at);
      if (text === undefined) return;
      const name = this.shown(roots, at);
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (hits.length < limit)
          hits.push(`${name}:${index + 1}: ${line.trim().slice(0, LINE_CHARS)}`);
        else dropped += 1;
      }
    };
    await visit(target.value, await isDirectory(target.value));
    return ok({ lines: hits, dropped });
  }

  // The path is resolved without `realpath`: a file the repair creates does not
  // exist yet. Its parent is, which is where a symlink leading out is caught.
  async write(path: string, content: string): Promise<Result<void>> {
    const target = resolve(path);
    let parent: string;
    try {
      parent = await realpath(dirname(target));
    } catch {
      return fail(`no such directory: ${dirname(path)}`);
    }
    const roots = await this.roots();
    if (!roots.some((root) => within(root, parent))) {
      return fail(`outside the readable trees: ${path}`);
    }
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(target, content, "utf8");
      return ok(undefined);
    } catch (error) {
      return fail(`cannot write: ${path}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
}
