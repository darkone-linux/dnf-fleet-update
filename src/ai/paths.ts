// Paths an AI tool may read (spec § analyse, outils `active`).
//
// Pure: the trees and the refusals are decided here. The adapter checks the
// **resolved** path again, which is where a symlink leading out is caught.

import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fail, ok, type Result } from "../model/result.ts";

/** Never readable, whatever the tree: secrets, the recycle bin, git internals. */
const DENIED = ["usr/secrets", ".trash", ".git"];

/**
 * Trees the AI may read: the consumer workspace, and `dnf/` beside it. Outside
 * codev `dnf/` is a locked flake input, so the directory may be absent — a read
 * under it then fails on the file, not on the rule.
 */
export const readableRoots = (workspace: string): string[] => [
  resolve(workspace),
  resolve(join(workspace, "dnf")),
];

/** Strictly inside `root`, or the root itself: segment-wise, never a bare prefix. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Absolute path to read, or the reason it is refused. `..` is resolved before the check. */
export function confine(roots: readonly string[], path: string): Result<string> {
  if (path.trim() === "") return fail("path is empty");
  const target = isAbsolute(path) ? normalize(path) : resolve(roots[0] ?? "", path);
  const root = roots.find((candidate) => within(candidate, target));
  if (root === undefined) return fail(`outside the readable trees: ${path}`);

  const relative = target.slice(root.length + 1);
  const denied = DENIED.find(
    (entry) => relative === entry || relative.startsWith(`${entry}${sep}`),
  );
  return denied === undefined ? ok(target) : fail(`not readable: ${denied}`);
}
