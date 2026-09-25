// Paths an AI tool may read, and the narrower set it may write (spec
// § analyse, outils `active`; § réparation, Garde-fous de l'écriture).
//
// Pure: the trees and the refusals are decided here. The adapter checks the
// **resolved** path again, which is where a symlink leading out is caught.

import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fail, ok, type Result } from "../model/result.ts";

/** Never readable, whatever the tree: secrets, the recycle bin, git internals. */
const DENIED = ["usr/secrets", ".trash", ".git"];

/**
 * Never writable on top of that (spec § réparation): generated data belongs to
 * `just generate`, the declaration to a human, a lock to `nix flake update`.
 */
const READ_ONLY = ["var/generated", "etc/config.yaml"];

/** A lock is regenerated, never edited: `flake.lock`, `bun.lock`, `Cargo.lock`. */
const LOCK = /\.lock$/;

/** Walked by no search nor listing, on top of `DENIED`: the trace of the runs. */
const UNWALKED = ["var/deployments"];

/** Skipped at any depth: git internals, dependencies, nix out-links, caches, desktop bins. */
const UNWALKED_NAME = /^(\.git|\.direnv|\.Trash-\d+|node_modules|result(-.*)?)$/;

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

const under = (relative: string, entry: string) =>
  relative === entry || relative.startsWith(`${entry}${sep}`);

/**
 * Most specific root holding `target`: `dnf/` sits inside the workspace, so
 * the first match would read `dnf/.git` as `dnf/.git` under the workspace and
 * let it through.
 */
function holder(roots: readonly string[], target: string): string | undefined {
  return roots
    .filter((candidate) => within(candidate, target))
    .reduce<string | undefined>(
      (best, candidate) =>
        best === undefined || candidate.length > best.length ? candidate : best,
      undefined,
    );
}

/** Repo an absolute path belongs to: `dnf/` beside the workspace, or it. */
export function repoOf(roots: readonly string[], target: string): string {
  return holder(roots, target) ?? roots[0] ?? "";
}

/** Absolute path to read, or the reason it is refused. `..` is resolved before the check. */
export function confine(roots: readonly string[], path: string): Result<string> {
  if (path.trim() === "") return fail("path is empty");
  const target = isAbsolute(path) ? normalize(path) : resolve(roots[0] ?? "", path);
  const root = holder(roots, target);
  if (root === undefined) return fail(`outside the readable trees: ${path}`);

  const relative = target.slice(root.length + 1);
  const denied = DENIED.find((entry) => under(relative, entry));
  return denied === undefined ? ok(target) : fail(`not readable: ${denied}`);
}

/**
 * `true`: a search or a listing met this entry and leaves it out (spec
 * § analyse, Trouver le code). `relative` to the root holding it; nested git
 * repositories and symlinks are the adapter's to catch, on the disk.
 */
export function unwalked(relative: string): boolean {
  const name = relative.split(sep).at(-1) ?? relative;
  if (UNWALKED_NAME.test(name)) return true;
  return [...DENIED, ...UNWALKED].some((entry) => under(relative, entry));
}

/**
 * Absolute path to write, or the reason it is refused: everything `confine`
 * refuses, plus the files a human or a generator owns. `codev` false: `dnf/`
 * is a locked flake input, so a store path — writing it would change nothing.
 */
export function writable(roots: readonly string[], path: string, codev: boolean): Result<string> {
  const target = confine(roots, path);
  if (!target.ok) return target;

  const [, framework] = roots;
  if (!codev && framework !== undefined && within(framework, target.value)) {
    return fail(`not writable outside co-development: ${path}`);
  }
  const relative = target.value.slice((holder(roots, target.value) ?? "").length + 1);
  if (LOCK.test(relative)) return fail(`not writable: a lock is regenerated, not edited`);

  const denied = READ_ONLY.find((entry) => under(relative, entry));
  return denied === undefined ? target : fail(`not writable: ${denied}`);
}
