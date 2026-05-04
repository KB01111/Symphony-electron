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
    const pr = input.proof.find((entry) => entry.kind === "pr" || entry.kind === "github_check");
    const complexity = input.proof.find((entry) => entry.kind === "complexity");
    const walkthrough = input.proof.find((entry) => entry.kind === "walkthrough_video");
    const hasPassingProof = input.proof.length > 0 && input.proof.every((entry) => entry.status === "passed");
    const proofLines = input.proof.length
      ? input.proof.map((entry) => `- [${entry.status}] ${entry.label}: ${entry.detail}${entry.url ? ` (${entry.url})` : ""}`).join("\n")
      : "- [unknown] No proof entries were recorded.";
    const body = [
      `## ${input.task.identifier}: ${input.task.title}`,
      "",
      input.task.url ? `Linear: ${input.task.url}` : "Linear: not linked",
      input.run.workspacePath ? `Workspace: ${input.run.workspacePath}` : "Workspace: not available",
      input.task.branchName ? `Branch: ${input.task.branchName}` : undefined,
      pr?.url ? `PR: ${pr.url}` : undefined,
      input.run.threadId ? `Codex thread: ${input.run.threadId}` : "Codex thread: not available",
      "",
      "## Proof",
      proofLines,
      complexity ? `\nComplexity: ${complexity.detail}` : undefined,
      walkthrough?.url ? `Walkthrough: ${walkthrough.url}` : undefined,
      "",
      "## Summary",
      input.transcriptSummary?.trim() || "No final summary was captured.",
      "",
      "## Operator Notes",
      "Review the workspace diff, proof entries, PR checks, reviews, and transcript before merge. Land only after explicit operator acceptance."
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    return {
      runId: input.run.id,
      taskId: input.task.id,
      title: `${input.task.identifier}: ${input.task.title}`,
      createdAt: this.now(),
      body,
      ...(input.task.branchName ? { branchName: input.task.branchName } : {}),
      ...(pr?.url ? { prUrl: pr.url } : {}),
      proofSummary: proofLines,
      diffSummary: input.proof.find((entry) => entry.kind === "diff")?.detail ?? "Diff summary was not recorded.",
      landingAllowed: input.run.state === "review" && hasPassingProof
    };
  }
}
