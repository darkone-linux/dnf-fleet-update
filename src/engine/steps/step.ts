// Step boundaries shared by the steps.

import type { StepId } from "../../model/events.ts";
import { emit, type RunContext } from "../context.ts";

export function endStep(context: RunContext, step: StepId, ok: boolean): void {
  // Aborted `now`: the run closes the step as `aborted`.
  if (!ok && context.signal.aborted) return;
  emit(context, { kind: "step.end", step, status: ok ? "ok" : "error" });
}
