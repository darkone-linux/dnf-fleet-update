// Bounded reads of a text file, for the AI tools (spec § analyse, Limites).
//
// Line by line through a ring buffer: a build log of tens of megabytes never
// lands in memory whole, and the count of dropped lines stays exact.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Excerpt } from "../engine/ports.ts";

const EMPTY: Excerpt = { lines: [], dropped: 0 };

async function eachLine(path: string, take: (line: string) => boolean): Promise<boolean> {
  try {
    const input = createReadStream(path, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of reader) {
        if (!take(line)) break;
      }
    } finally {
      reader.close();
      input.destroy();
    }
    return true;
  } catch {
    // Missing or unreadable: the step that writes it never ran.
    return false;
  }
}

/** Last `lines` of the file: an error sits at the bottom of a log. */
export async function tailLines(path: string, lines: number): Promise<Excerpt> {
  if (lines <= 0) return EMPTY;
  const kept: string[] = [];
  let total = 0;
  const read = await eachLine(path, (line) => {
    total += 1;
    kept.push(line);
    if (kept.length > lines) kept.shift();
    return true;
  });
  return read ? { lines: kept, dropped: total - kept.length } : EMPTY;
}

/** First `lines` of the file: a module is read from its header down. */
export async function headLines(path: string, lines: number): Promise<Excerpt | undefined> {
  if (lines <= 0) return { lines: [], dropped: 0 };
  const kept: string[] = [];
  let total = 0;

  // Counting past the cut costs one pass; it tells the reader what it misses.
  const read = await eachLine(path, (line) => {
    total += 1;
    if (kept.length < lines) kept.push(line);
    return true;
  });
  return read ? { lines: kept, dropped: total - kept.length } : undefined;
}
