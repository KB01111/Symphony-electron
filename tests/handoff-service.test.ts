import { expect, test } from "vitest";
import { HandoffService } from "../src/main/services/handoff-service.js";
import type { ProofEntry, Run, Task } from "../src/shared/types.js";

function task(): Task {
  return {
    id: "linear:lin-1",
    source: "linear",
    externalId: "lin-1",
    identifier: "ENG-42",
    title: "Ship the orchestrator",
    description: "Make it usable",
    url: "https://linear.app/acme/issue/ENG-42",
    status: "Ready",
    priority: 1,
    labels: ["automation"],
    updatedAt: "2026-05-02T10:00:00.000Z"
  };
}

function run(): Run {
  return {
    id: "run-1",
    taskId: "linear:lin-1",
    profileId: "profile-1",
    state: "review",
    workspacePath: "C:\\workspaces\\ENG-42",
    threadId: "thread-1",
    startedAt: "2026-05-02T10:00:00.000Z",
    completedAt: "2026-05-02T10:30:00.000Z",
    updatedAt: "2026-05-02T10:30:00.000Z"
  };
}

test("builds a review handoff from task, run, proof and transcript", () => {
  const proof: ProofEntry[] = [
    {
      id: "proof-1",
      runId: "run-1",
      kind: "test",
      label: "npm test",
      status: "passed",
      detail: "42 passed",
      createdAt: "2026-05-02T10:20:00.000Z"
    }
  ];
  const handoff = new HandoffService(() => "2026-05-02T10:31:00.000Z").build({
    task: task(),
    run: run(),
    proof,
    transcriptSummary: "Implemented orchestrator readiness."
  });

  expect(handoff).toMatchObject({
    runId: "run-1",
    taskId: "linear:lin-1",
    title: "ENG-42: Ship the orchestrator",
    createdAt: "2026-05-02T10:31:00.000Z"
  });
  expect(handoff.body).toContain("https://linear.app/acme/issue/ENG-42");
  expect(handoff.body).toContain("C:\\workspaces\\ENG-42");
  expect(handoff.body).toContain("- [passed] npm test: 42 passed");
  expect(handoff.body).toContain("Implemented orchestrator readiness.");
});
