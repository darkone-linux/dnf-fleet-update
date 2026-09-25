// Real `SuggestionFiles`: `var/deployments/suggestions/<slug>.md`.
//
// Beside the run directories, never taken for one: `DirectoryStore.last()`
// only reads names shaped like a run.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SuggestionFile, SuggestionFiles } from "../engine/ports.ts";
import { fail, ok, type Result } from "../model/result.ts";

/** Validated upstream (`ai/suggestions.ts`): a miss here is a bug, not a refusal. */
const NAME = /^[a-z0-9-]+$/;

export class DirectorySuggestions implements SuggestionFiles {
  /** `dir`: `<workspace>/var/deployments/suggestions`. */
  constructor(private readonly dir: string) {}

  private file(slug: string): string {
    if (!NAME.test(slug)) throw new Error(`unsafe suggestion name: ${JSON.stringify(slug)}`);
    return join(this.dir, `${slug}.md`);
  }

  async list(): Promise<SuggestionFile[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files: SuggestionFile[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
      const slug = name.slice(0, -".md".length);
      if (!NAME.test(slug)) continue;
      const text = await this.read(slug);
      if (text !== undefined) files.push({ slug, text });
    }
    return files;
  }

  async read(slug: string): Promise<string | undefined> {
    try {
      return await readFile(this.file(slug), "utf8");
    } catch {
      return undefined;
    }
  }

  async write(slug: string, text: string): Promise<Result<void>> {
    const target = this.file(slug);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(target, text, "utf8");
      return ok(undefined);
    } catch (error) {
      return fail(`cannot write ${slug}.md: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
}
