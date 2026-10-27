// Bounded parallelism of a wave (`--max-parallel`).

/** Runs one task at a time, in call order; a task that rejects does not block the next. */
export type Turn = <T>(task: () => Promise<T>) => Promise<T>;

export function serial(): Turn {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Starts nothing more once `stop` fires; tasks already started run to their end. */
export async function pool(
  names: readonly string[],
  size: number,
  stop: AbortSignal,
  task: (name: string) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < names.length && !stop.aborted) {
      const name = names[next]!;
      next += 1;
      await task(name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, names.length) }, worker));
}
