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

function runMinimal(): Run {
  return {
    id: "run-2",
    taskId: "linear:lin-2",
    profileId: "profile-1",
    state: "review",
    startedAt: "2026-05-02T10:00:00.000Z",
    updatedAt: "2026-05-02T10:30:00.000Z"
    // No workspacePath, threadId, or completedAt
  };
}

function taskMinimal(): Task {
  return {
    id: "linear:lin-2",
    source: "linear",
    externalId: "lin-2",
    identifier: "ENG-99",
    title: "Minimal task",
    description: "",
    // No url
    status: "Ready",
    priority: 0,
    labels: [],
    updatedAt: "2026-05-02T10:00:00.000Z"
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

test("uses fallback text when proof array is empty", () => {
  const handoff = new HandoffService(() => "2026-05-02T10:31:00.000Z").build({
    task: task(),
    run: run(),
    proof: []
  });

  expect(handoff.body).toContain("- [unknown] No proof entries were recorded.");
});

test("uses fallback text when transcript summary is absent", () => {
  const handoff = new HandoffService(() => "2026-05-02T10:31:00.000Z").build({
    task: task(),
    run: run(),
    proof: []
  });

  expect(handoff.body).toContain("No final summary was captured.");
});

test("uses fallback text when transcript summary is whitespace only", () => {
  const handoff = new HandoffService(() => "2026-05-02T10:31:00.000Z").build({
    task: task(),
    run: run(),
    proof: [],
    transcriptSummary: "   \t\n   "
  });

  expect(handoff.body).toContain("No final summary was captured.");
});

test("shows not-linked placeholders when task URL, workspace, and thread are absent", () => {
  const handoff = new HandoffService().build({
    task: taskMinimal(),
    run: runMinimal(),
    proof: []
  });

  expect(handoff.body).toContain("Linear: not linked");
  expect(handoff.body).toContain("Workspace: not available");
  expect(handoff.body).toContain("Codex thread: not available");
});

test("formats multiple proof entries with their respective statuses", () => {
  const proof: ProofEntry[] = [
    { id: "p1", runId: "run-1", kind: "test", label: "unit tests", status: "passed", detail: "10 passed", createdAt: "2026-05-02T10:00:00.000Z" },
    { id: "p2", runId: "run-1", kind: "ci", label: "CI pipeline", status: "failed", detail: "build failed", createdAt: "2026-05-02T10:01:00.000Z" },
    { id: "p3", runId: "run-1", kind: "review", label: "lint", status: "warning", detail: "2 warnings", createdAt: "2026-05-02T10:02:00.000Z" }
  ];
  const handoff = new HandoffService().build({ task: task(), run: run(), proof });

  expect(handoff.body).toContain("- [passed] unit tests: 10 passed");
  expect(handoff.body).toContain("- [failed] CI pipeline: build failed");
  expect(handoff.body).toContain("- [warning] lint: 2 warnings");
  // Should not contain the fallback
  expect(handoff.body).not.toContain("No proof entries were recorded.");
});
