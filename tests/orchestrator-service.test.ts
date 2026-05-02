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

function run(id: string, taskId: string, state: Run["state"] = "running"): Run {
  return {
    id,
    taskId,
    profileId: "profile-1",
    state,
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

test("existing active and preparing runs consume concurrency", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  const startRun = vi.fn();
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a"), task("b")],
    listRuns: async () => [run("run-existing", "existing", "preparing"), run("run-active", "active", "running")],
    startRun,
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(startRun).not.toHaveBeenCalled();
  expect(snapshot.queuedTaskIds).toEqual(["a", "b"]);
});

test("future retry entries delay dispatch and queue the task", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    retryQueue: [
      {
        taskId: "a",
        attempts: 2,
        nextAttemptAt: "2026-05-02T10:05:00.000Z",
        lastError: "temporary failure"
      }
    ]
  };
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
  expect(snapshot.state.retryQueue).toEqual(state.retryQueue);
});

test("due retry entries are allowed and cleared on successful start", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    retryQueue: [
      {
        taskId: "a",
        attempts: 2,
        nextAttemptAt: "2026-05-02T09:59:00.000Z",
        lastError: "temporary failure"
      }
    ]
  };
  const started: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [],
    startRun: async (candidate) => {
      started.push(candidate.id);
      return run(`run-${candidate.id}`, candidate.id);
    },
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(started).toEqual(["a"]);
  expect(snapshot.state.retryQueue).toEqual([]);
});

test("failed starts replace and increment retry entries instead of duplicating them", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    retryQueue: [
      {
        taskId: "a",
        attempts: 2,
        nextAttemptAt: "2026-05-02T09:59:00.000Z",
        lastError: "previous failure"
      }
    ]
  };
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [],
    startRun: async () => {
      throw new Error("still failing");
    },
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(snapshot.state.retryQueue).toEqual([
    {
      taskId: "a",
      attempts: 3,
      nextAttemptAt: "2026-05-02T10:00:40.000Z",
      lastError: "still failing"
    }
  ]);
});

test("overlapping ticks do not duplicate starts for the same candidate", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  let releaseStartRun: (() => void) | undefined;
  const startRun = vi.fn(
    async (candidate: Task) =>
      new Promise<Run>((resolve) => {
        releaseStartRun = () => resolve(run(`run-${candidate.id}`, candidate.id));
      })
  );
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

  const firstTick = service.tick();
  await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
  const secondTick = service.tick();

  releaseStartRun?.();
  await Promise.all([firstTick, secondTick]);

  expect(startRun).toHaveBeenCalledTimes(1);
});

test("pause waits behind an in-flight tick and final state remains paused", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  let releaseStartRun: (() => void) | undefined;
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [],
    startRun: async (candidate) =>
      new Promise<Run>((resolve) => {
        releaseStartRun = () => resolve(run(`run-${candidate.id}`, candidate.id));
      }),
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const tick = service.tick();
  await vi.waitFor(() => expect(releaseStartRun).toBeDefined());
  const pause = service.pause();

  releaseStartRun?.();
  await tick;
  const paused = await pause;

  expect(paused.paused).toBe(true);
  expect(state.paused).toBe(true);
});
