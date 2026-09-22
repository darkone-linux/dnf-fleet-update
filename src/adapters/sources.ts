// Real `SourceFiles`: the trees the AI may read, and nothing else.
//
// Confinement is checked twice — on the asked path (pure, `ai/paths.ts`) and
// here on the **resolved** one: a symlink leading out of a root is an escape,
// not a shortcut.

import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Excerpt, SourceFiles } from "../engine/ports.ts";
import { fail, ok, type Result } from "../model/result.ts";
import { headLines } from "./tail.ts";

/** Strictly inside `root`, or the root itself: compared segment-wise, never by prefix alone. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export class DirectorySources implements SourceFiles {
  private readonly asked: string[];
  private resolved?: Promise<string[]>;

  /** Roots the AI may read: the consumer workspace, and `dnf/` beside it. */
  constructor(roots: readonly string[]) {
    this.asked = roots.map((root) => resolve(root));
  }

  // Outside codev `dnf/` is a store path reached through a symlink, so the
  // roots are resolved too: otherwise every read under it would read as an escape.
  private roots(): Promise<string[]> {
    this.resolved ??= Promise.all(this.asked.map((root) => realpath(root).catch(() => root)));
    return this.resolved;
  }

  async read(path: string, lines: number): Promise<Result<Excerpt>> {
    let target: string;
    try {
      target = await realpath(resolve(path));
    } catch {
      return fail(`no such file: ${path}`);
    }
    const roots = await this.roots();
    if (!roots.some((root) => within(root, target)))
      return fail(`outside the readable trees: ${path}`);

    const excerpt = await headLines(target, lines);
    return excerpt === undefined ? fail(`cannot read: ${path}`) : ok(excerpt);
  }
}
