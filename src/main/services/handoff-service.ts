import type { HandoffDraft, ProofEntry, Run, Task } from "../../shared/types.js";
import { isoNow } from "./time.js";

interface HandoffInput {
  task: Task;
  run: Run;
  proof: ProofEntry[];
  transcriptSummary?: string;
}

export class HandoffService {
  constructor(private readonly now: () => string = () => isoNow()) {}

  build(input: HandoffInput): HandoffDraft {
    const proofLines = input.proof.length
      ? input.proof.map((entry) => `- [${entry.status}] ${entry.label}: ${entry.detail}`).join("\n")
      : "- [unknown] No proof entries were recorded.";
    const body = [
      `## ${input.task.identifier}: ${input.task.title}`,
      "",
      input.task.url ? `Linear: ${input.task.url}` : "Linear: not linked",
      input.run.workspacePath ? `Workspace: ${input.run.workspacePath}` : "Workspace: not available",
      input.run.threadId ? `Codex thread: ${input.run.threadId}` : "Codex thread: not available",
      "",
      "## Proof",
      proofLines,
      "",
      "## Summary",
      input.transcriptSummary?.trim() || "No final summary was captured.",
      "",
      "## Operator Notes",
      "Review the workspace diff, proof entries, and transcript before merge."
    ].join("\n");

    return {
      runId: input.run.id,
      taskId: input.task.id,
      title: `${input.task.identifier}: ${input.task.title}`,
      createdAt: this.now(),
      body
    };
  }
}
