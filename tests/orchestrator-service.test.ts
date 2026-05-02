import { expect, test, vi } from "vitest";
import { OrchestratorService } from "../src/main/services/orchestrator-service.js";
import { defaultOrchestratorState } from "../src/main/services/orchestrator-state.js";
import type { OrchestratorState, Run, Task } from "../src/shared/types.js";

function task(id: string, status = "Ready"): Task {
  return {
    id,
    source: "linear",
    externalId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    description: "",
    status,
    priority: 0,
    updatedAt: "2026-05-02T10:00:00.000Z"
  };
}

function run(id: string, taskId: string): Run {
  return {
    id,
    taskId,
    profileId: "profile-1",
    state: "running",
    updatedAt: "2026-05-02T10:00:00.000Z",
    startedAt: "2026-05-02T10:00:00.000Z"
  };
}

test("dispatches eligible Linear tasks up to the autonomous concurrency limit", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  const started: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a"), task("b"), task("c")],
    listRuns: async () => [],
    startRun: async (candidate) => {
      started.push(candidate.id);
      return run(`run-${candidate.id}`, candidate.id);
    },
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(started).toEqual(["a", "b"]);
  expect(snapshot.state.activeClaims.map((claim) => claim.taskId)).toEqual(["a", "b"]);
  expect(snapshot.queuedTaskIds).toEqual(["c"]);
});

test("does not dispatch while paused", async () => {
  let state: OrchestratorState = { ...defaultOrchestratorState(), paused: true };
  const startRun = vi.fn();
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [],
    startRun,
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(startRun).not.toHaveBeenCalled();
  expect(snapshot.queuedTaskIds).toEqual(["a"]);
});
