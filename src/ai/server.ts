// MCP endpoint of one run, opened at most once (spec § analyse, Transport).
//
// Lazy on purpose: most runs never ask the AI anything, and a server nobody
// calls is a port open for nothing.

import { disableAi, type RunContext } from "../engine/context.ts";
import type { PersistedState } from "../model/persist.ts";
import { toolContext } from "./context.ts";
import type { RunTools } from "./providers.ts";
import { dispatch } from "./rpc.ts";
import { toolLevel, toolsFor } from "./tools/registry.ts";
import { SESSION_KINDS, type SessionKind } from "./tools/types.ts";

/** Path segment of a request; absent or unknown: the narrowest session, analysis. */
const sessionKind = (segment: string | undefined): SessionKind =>
  SESSION_KINDS.find((kind) => kind === segment) ?? "analysis";

export class AiToolSession {
  private opening?: Promise<RunTools | undefined>;
  private open = false;

  /**
   * Endpoint of this run, started on the first call that needs it and reused
   * after that; `forSession` points a session at it. `undefined`: the level
   * grants no tool, or the server refused to start — the question is then
   * asked without tools, never dropped.
   */
  start(context: RunContext, state: () => PersistedState): Promise<RunTools | undefined> {
    this.opening ??= this.listen(context, state);
    return this.opening;
  }

  private async listen(
    context: RunContext,
    state: () => PersistedState,
  ): Promise<RunTools | undefined> {
    const level = toolLevel(context.params);
    if (level === undefined) return undefined;

    const served = { context: toolContext(context, state), version: version(state) };
    try {
      const endpoint = await context.toolServer.start((message, segment) =>
        dispatch(message, { ...served, tools: toolsFor(level, sessionKind(segment)) }),
      );
      this.open = true;
      return { endpoint, level };
    } catch {
      // A port that will not bind is not a reason to fail a deployment.
      disableAi(context, "the tool server could not be started");
      return undefined;
    }
  }

  /** Idempotent, and safe on a run that never opened one. */
  async stop(context: RunContext): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await context.toolServer.stop();
  }
}

const version = (state: () => PersistedState) => state().run?.version ?? "0";
