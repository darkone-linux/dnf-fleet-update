// Real `CommandRunner`: `Bun.spawn`, one process group per command.
//
// `detached` calls `setsid()`: SIGTERM then SIGKILL reach the whole group on
// deadline or abort, grandchildren included (spec § Délais).

import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
  OutputLine,
  RunOptions,
} from "../engine/ports.ts";

interface Pump {
  done: Promise<void>;
  cancel(): void;
}

/** Lines as they come; a last line without newline is still delivered. */
function pump(
  stream: ReadableStream<Uint8Array>,
  name: OutputLine["stream"],
  onLine: RunOptions["onLine"],
): Pump {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const done = (async () => {
    let pending = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const lines = (pending + decoder.decode(chunk.value, { stream: true })).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine?.({ stream: name, line });
    }
    pending += decoder.decode();
    if (pending.length > 0) onLine?.({ stream: name, line: pending });
  })();

  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => undefined);
    },
  };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** Missing program or working directory: thrown by `Bun.spawn` itself. */
function spawn(spec: CommandSpec) {
  try {
    return Bun.spawn([...spec.argv], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdin: spec.stdin === undefined ? "ignore" : new TextEncoder().encode(spec.stdin),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot start ${spec.argv[0]}: ${reason}`, { cause: error });
  }
}

export class ProcessRunner implements CommandRunner {
  async run(spec: CommandSpec, options: RunOptions = {}): Promise<CommandResult> {
    const { signal, onLine } = options;
    signal?.throwIfAborted();
    const started = performance.now();
    const child = spawn(spec);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let markKilled = () => {};
    const killed = new Promise<void>((resolve) => {
      markKilled = resolve;
    });

    const terminate = () => {
      if (killTimer !== undefined) return;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup(child.pid, "SIGKILL");
        markKilled();
      }, spec.killGraceMs);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, spec.timeoutMs);
    signal?.addEventListener("abort", terminate, { once: true });

    const pumps = [pump(child.stdout, "stdout", onLine), pump(child.stderr, "stderr", onLine)];
    const drained = Promise.all(pumps.map((each) => each.done));
    try {
      // Leftovers of the group may hold the pipes after the leader: same deadline.
      await Promise.all([child.exited, Promise.race([drained, killed])]);
    } catch (error) {
      // A throwing `onLine` is a bug: no process left behind.
      signalGroup(child.pid, "SIGKILL");
      throw error;
    } finally {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
      for (const each of pumps) each.cancel();
    }

    return {
      exitCode: child.exitCode,
      signal: child.signalCode,
      timedOut,
      durationMs: performance.now() - started,
    };
  }
}
