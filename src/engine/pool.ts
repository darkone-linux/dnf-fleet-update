// Bounded parallelism of a wave (`--max-parallel`).

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
