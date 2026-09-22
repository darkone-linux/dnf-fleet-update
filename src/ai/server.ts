// MCP endpoint of one run, opened at most once (spec § analyse, Transport).
//
// Lazy on purpose: most runs never ask the AI anything, and a server nobody
// calls is a port open for nothing.

import { disableAi, type RunContext } from "../engine/context.ts";
import type { PersistedState } from "../model/persist.ts";
import { toolContext } from "./context.ts";
import type { AiTools } from "./providers.ts";
import { dispatch } from "./rpc.ts";
import { qualified, toolLevel, toolsFor } from "./tools/registry.ts";

export class AiToolSession {
  private opening?: Promise<AiTools | undefined>;
  private open = false;

  /**
   * Endpoint of this run, started on the first call that needs it and reused
   * after that. `undefined`: the level grants no tool, or the server refused to
   * start — the question is then asked without tools, never dropped.
   */
  start(context: RunContext, state: () => PersistedState): Promise<AiTools | undefined> {
    this.opening ??= this.listen(context, state);
    return this.opening;
  }

  private async listen(
    context: RunContext,
    state: () => PersistedState,
  ): Promise<AiTools | undefined> {
    const level = toolLevel(context.params);
    if (level === undefined) return undefined;

    const tools = toolsFor(level);
    const served = { tools, context: toolContext(context, state), version: version(state) };
    try {
      const endpoint = await context.toolServer.start((message) => dispatch(message, served));
      this.open = true;
      return { endpoint, names: tools.map(qualified) };
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
