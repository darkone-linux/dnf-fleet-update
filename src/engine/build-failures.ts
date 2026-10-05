// Derivations failed by themselves during one build (spec § Erreurs et
// réparations): nix keeps no failure, every build waiting on one would build
// it again. A host whose closure holds one fails without building.

import { derivationClosure } from "./commands/nix.ts";
import type { RunContext } from "./context.ts";
import { execute, succeeded } from "./exec.ts";

export interface FailedBuild {
  /** Derivation whose own builder exited non-zero. */
  drv: string;

  /** Host whose build met it first. */
  host: string;
  note: string;
  excerpt: string[];
}

/** One host under watch: aborted once a failed derivation lies in its closure. */
export interface FailureWatch {
  readonly signal: AbortSignal;

  /** Set when `signal` aborted: the failure the host inherits. */
  readonly failure: FailedBuild | undefined;
  close(): void;
}

type Check = (failure: FailedBuild) => Promise<void>;

export class BuildFailures {
  private readonly failed = new Map<string, FailedBuild>();
  private readonly checks = new Set<Check>();
  private readonly pending = new Set<Promise<void>>();
  private readonly closures = new Map<string, Promise<ReadonlySet<string>>>();

  constructor(private readonly context: RunContext) {}

  /** The first failure of a derivation is kept: a later one says nothing new. */
  record(failure: FailedBuild): void {
    if (this.failed.has(failure.drv)) return;
    this.failed.set(failure.drv, failure);
    for (const check of this.checks) {
      const pending: Promise<void> = check(failure).then(() => {
        this.pending.delete(pending);
      });
      this.pending.add(pending);
    }
  }

  /** Resolves once the failures already known are checked: a hit is known before any build. */
  async watch(host: string, drvPath: string): Promise<FailureWatch> {
    const controller = new AbortController();
    let failure: FailedBuild | undefined;
    const check: Check = async (candidate) => {
      if (candidate.host === host || controller.signal.aborted) return;
      const closure = await this.closureOf(drvPath);
      if (!closure.has(candidate.drv) || controller.signal.aborted) return;
      failure = candidate;
      controller.abort(new Error(`${candidate.drv} failed`));
    };
    this.checks.add(check);
    await Promise.all([...this.failed.values()].map(check));
    return {
      signal: controller.signal,
      get failure() {
        return failure;
      },
      close: () => {
        this.checks.delete(check);
      },
    };
  }

  /** Every check started has ended: no query outlives the build step. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Read at the first failure only, once per host. */
  private closureOf(drvPath: string): Promise<ReadonlySet<string>> {
    let closure = this.closures.get(drvPath);
    if (closure === undefined) {
      closure = this.query(drvPath);
      this.closures.set(drvPath, closure);
    }
    return closure;
  }

  /** Empty when unreadable: the host builds, and meets the failure itself. */
  private async query(drvPath: string): Promise<ReadonlySet<string>> {
    const spec = derivationClosure(drvPath, this.context.params.timeouts);
    try {
      const execution = await execute(this.context, spec, { signal: this.context.flow.halt });
      if (!succeeded(execution.result)) return new Set();
      return new Set(execution.stdout.map((line) => line.trim()));
    } catch {
      return new Set();
    }
  }
}
