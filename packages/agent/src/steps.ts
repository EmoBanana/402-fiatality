/** Numbered AgentStepDTOs for one run, delivered through `onStep`. */
import type { AgentStepDTO, AgentStepKind } from "@p402/shared";
import { truncate } from "./util";

export type StepFields = Partial<Pick<AgentStepDTO, "costMicros" | "cumulativeMicros" | "sellerId" | "endpoint" | "status" | "voidReason" | "data">>;

const MAX_TEXT = 600;

export class StepEmitter {
  private next = 0;

  constructor(
    private readonly runId: string,
    private readonly onStep: (step: AgentStepDTO) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get count(): number {
    return this.next;
  }

  emit(kind: AgentStepKind, text: string, fields: StepFields = {}): AgentStepDTO {
    const step: AgentStepDTO = { runId: this.runId, index: this.next++, kind, text: truncate(text, MAX_TEXT), at: this.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) (step as unknown as Record<string, unknown>)[key] = value;
    }
    try {
      this.onStep(step);
    } catch {
      // A failing listener (e.g. a closed socket) must not end the run.
    }
    return step;
  }
}
