import { expect, test, vi } from "vitest";
import { OrchestratorService } from "../src/main/services/orchestrator-service.js";
import { defaultOrchestratorState } from "../src/main/services/orchestrator-state.js";
import type { OrchestratorState, Run, Task } from "../src/shared/types.js";

function task(id: string, status = "Ready", overrides: Partial<Task> = {}): Task {
  return {
    id,
    source: "linear",
    externalId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    description: "",
    status,
    priority: 0,
    updatedAt: "2026-05-02T10:00:00.000Z",
    ...overrides
  };
}

function todoTask(id: string, blockerState = "In Progress"): Task {
  return task(id, "Todo", {
    blockers: [{ id: "dep-1", identifier: "DEP-1", state: blockerState }]
  });
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
  expect(snapshot.queue).toMatchObject([{ taskId: "a", reason: "paused" }]);
});

test("reports queue reasons for blockers and concurrency", async () => {
  let state: OrchestratorState = { ...defaultOrchestratorState(), policy: { ...defaultOrchestratorState().policy, maxConcurrentRuns: 1 } };
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("active"), todoTask("blocked"), task("queued")],
    listRuns: async () => [],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(snapshot.state.activeClaims.map((claim) => claim.taskId)).toEqual(["active"]);
  expect(snapshot.queue).toEqual([
    expect.objectContaining({ taskId: "blocked", reason: "blocked" }),
    expect.objectContaining({ taskId: "queued", reason: "concurrency" })
  ]);
  expect(snapshot.nextPollAt).toBe("2026-05-02T10:01:00.000Z");
});

test("reconciles tracker terminal state and cleans workspaces", async () => {
  const cleaned: string[] = [];
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [{ taskId: "a", runId: "run-a", identifier: "A", startedAt: "2026-05-02T10:00:00.000Z" }]
  };
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    getIssueState: async () => ({ status: "Done" }),
    listRuns: async () => [{ ...run("run-a", "a", "running"), updatedAt: "2026-05-02T09:00:00.000Z" }],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    terminateRun: async () => undefined,
    cleanWorkspace: async (candidate) => {
      cleaned.push(candidate.id);
    },
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(snapshot.state.activeClaims).toEqual([]);
  expect(cleaned).toEqual(["a"]);
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

test("stalled runs consume concurrency and keep active claims", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "stalled-task",
        runId: "run-stalled",
        identifier: "STALLED",
        startedAt: "2026-05-02T09:55:00.000Z"
      }
    ],
    policy: {
      ...defaultOrchestratorState().policy,
      maxConcurrentRuns: 1
    }
  };
  const startRun = vi.fn();
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("stalled-task"), task("a")],
    listRuns: async () => [run("run-stalled", "stalled-task", "stalled")],
    startRun,
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(startRun).not.toHaveBeenCalled();
  expect(snapshot.queuedTaskIds).toEqual(["a"]);
  expect(snapshot.state.activeClaims).toEqual(state.activeClaims);
});

test("terminal runs block automatic reruns for the same task", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  const startRun = vi.fn();
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [run("run-a", "a", "review")],
    startRun,
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(startRun).not.toHaveBeenCalled();
  expect(snapshot.state.activeClaims).toEqual([]);
  expect(snapshot.queuedTaskIds).toEqual([]);
});

test("does not dispatch Todo tasks with non-terminal blockers", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    policy: {
      ...defaultOrchestratorState().policy,
      terminalStateNames: ["Done", "Closed"]
    }
  };
  const started: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [todoTask("blocked"), todoTask("ready", "Done")],
    listRuns: async () => [],
    startRun: async (candidate) => {
      started.push(candidate.id);
      return run(`run-${candidate.id}`, candidate.id);
    },
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(started).toEqual(["ready"]);
  expect(snapshot.queuedTaskIds).toEqual(["blocked"]);
});

test("applies per-state concurrency limits before the global limit", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    policy: {
      ...defaultOrchestratorState().policy,
      maxConcurrentRuns: 4,
      maxConcurrentRunsByState: { ready: 1 }
    }
  };
  const started: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a"), task("b")],
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
  expect(snapshot.queuedTaskIds).toEqual(["b"]);
});

test("stale active claims are cancelled and retried with backoff", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "a",
        runId: "run-a",
        identifier: "A",
        startedAt: "2026-05-02T09:00:00.000Z",
        lastEventAt: "2026-05-02T09:00:00.000Z"
      }
    ],
    policy: { ...defaultOrchestratorState().policy, stallTimeoutSeconds: 60 }
  };
  const cancelled: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [],
    listRuns: async () => [{ ...run("run-a", "a", "running"), updatedAt: "2026-05-02T09:00:00.000Z" }],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    terminateRun: async (runId) => {
      cancelled.push(runId);
    },
    now: () => new Date("2026-05-02T09:02:01.000Z")
  });

  const snapshot = await service.tick();

  expect(cancelled).toEqual(["run-a"]);
  expect(snapshot.state.activeClaims).toEqual([]);
  expect(snapshot.state.retryQueue).toEqual([
    {
      taskId: "a",
      attempts: 1,
      nextAttemptAt: "2026-05-02T09:02:11.000Z",
      lastError: "stalled"
    }
  ]);
});

test("uses the latest run activity timestamp when evaluating stalls", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "a",
        runId: "run-a",
        identifier: "A",
        startedAt: "2026-05-02T09:00:00.000Z",
        lastEventAt: "2026-05-02T09:00:00.000Z"
      }
    ],
    policy: { ...defaultOrchestratorState().policy, stallTimeoutSeconds: 60 }
  };
  const cancelled: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [{ ...run("run-a", "a", "running"), updatedAt: "2026-05-02T09:01:30.000Z" }],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    terminateRun: async (runId) => {
      cancelled.push(runId);
    },
    now: () => new Date("2026-05-02T09:02:01.000Z")
  });

  const snapshot = await service.tick();

  expect(cancelled).toEqual([]);
  expect(snapshot.state.activeClaims).toMatchObject([
    {
      taskId: "a",
      runId: "run-a",
      lastEventAt: "2026-05-02T09:01:30.000Z"
    }
  ]);
  expect(snapshot.state.retryQueue).toEqual([]);
});

test("terminal tracker states cancel active claims without retry", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "a",
        runId: "run-a",
        identifier: "A",
        startedAt: "2026-05-02T09:00:00.000Z"
      }
    ],
    policy: { ...defaultOrchestratorState().policy, terminalStateNames: ["Done"] }
  };
  const cancelled: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a", "Done")],
    listRuns: async () => [run("run-a", "a", "running")],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    terminateRun: async (runId) => {
      cancelled.push(runId);
    },
    now: () => new Date("2026-05-02T09:02:01.000Z")
  });

  const snapshot = await service.tick();

  expect(cancelled).toEqual(["run-a"]);
  expect(snapshot.state.activeClaims).toEqual([]);
  expect(snapshot.state.retryQueue).toEqual([]);
});

test("scheduled tick failure recording retries when state persistence fails", async () => {
  vi.useFakeTimers();
  try {
    let writes = 0;
    let state = { ...defaultOrchestratorState(), policy: { ...defaultOrchestratorState().policy, pollIntervalSeconds: 1 } };
    const service = new OrchestratorService({
      readState: async () => state,
      writeState: async (next) => {
        writes += 1;
        if (writes > 1) {
          throw new Error("state unavailable");
        }
        state = next;
      },
      listCandidateTasks: async () => {
        throw new Error("sync failed");
      },
      listRuns: async () => [],
      startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
      appendEvent: async () => undefined,
      now: () => new Date("2026-05-02T10:00:00.000Z")
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(vi.getTimerCount()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
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

test("event logging failures after a successful start keep the active claim without retrying", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    retryQueue: [
      {
        taskId: "a",
        attempts: 1,
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
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => {
      throw new Error("event log unavailable");
    },
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(snapshot.state.activeClaims).toEqual([
    {
      taskId: "a",
      runId: "run-a",
      identifier: "A",
      startedAt: "2026-05-02T10:00:00.000Z"
    }
  ]);
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

test("orphaned active claims are dropped before enforcing concurrency", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "orphaned",
        runId: "missing-run",
        identifier: "ORPHANED",
        startedAt: "2026-05-02T09:55:00.000Z"
      }
    ],
    policy: {
      ...defaultOrchestratorState().policy,
      maxConcurrentRuns: 1
    }
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
  expect(snapshot.queuedTaskIds).toEqual([]);
  expect(snapshot.state.activeClaims.map((claim) => claim.taskId)).toEqual(["a"]);
});

test("overlapping ticks do not duplicate starts for the same candidate", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  const runs: Run[] = [];
  let releaseStartRun: (() => void) | undefined;
  const startRun = vi.fn(
    async (candidate: Task) =>
      new Promise<Run>((resolve) => {
        releaseStartRun = () => {
          const startedRun = run(`run-${candidate.id}`, candidate.id);
          runs.push(startedRun);
          resolve(startedRun);
        };
      })
  );
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => runs,
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

test("queued pause prevents a finishing scheduled tick from scheduling another timer", async () => {
  vi.useFakeTimers();
  try {
    let state: OrchestratorState = { ...defaultOrchestratorState(), policy: { ...defaultOrchestratorState().policy, pollIntervalSeconds: 1 } };
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

    await service.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(releaseStartRun).toBeDefined());

    const pause = service.pause();
    releaseStartRun?.();
    await pause;

    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("stop prevents a finishing scheduled tick from scheduling another timer", async () => {
  vi.useFakeTimers();
  try {
    let state: OrchestratorState = { ...defaultOrchestratorState(), policy: { ...defaultOrchestratorState().policy, pollIntervalSeconds: 1 } };
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

    await service.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(releaseStartRun).toBeDefined());

    service.stop();
    releaseStartRun?.();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  } finally {
    vi.useRealTimers();
  }
});
