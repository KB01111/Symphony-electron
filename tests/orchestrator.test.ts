import { expect, test } from "vitest";
import { OrchestrationService } from "../src/main/services/orchestration-service.js";
import type { HealthCheckResult, LinearConfig, Profile, Run, Task } from "../src/shared/types.js";

function linearConfig(): LinearConfig {
  return {
    apiKey: "lin_test",
    activeStateNames: ["Ready", "Todo", "In Progress"],
    terminalStateNames: ["Done", "Canceled"],
    pollIntervalSeconds: 60,
    maxConcurrentRuns: 2,
    humanReviewStateName: "Human Review",
    inProgressStateName: "In Progress"
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `linear:${id}`,
    source: "linear",
    externalId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    description: "",
    status: "Ready",
    priority: 2,
    labels: [],
    blockers: [],
    updatedAt: "2026-05-01T10:00:00.000Z",
    createdAt: "2026-05-01T09:00:00.000Z",
    ...overrides
  };
}

function profile(id: string): Profile {
  return {
    id,
    name: id,
    codexHome: `C:\\tmp\\${id}\\codex-home`,
    workspaceRoot: `C:\\tmp\\${id}\\workspaces`,
    repoCacheRoot: `C:\\tmp\\${id}\\repos`,
    logsRoot: `C:\\tmp\\${id}\\logs`,
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
}

test("dispatches eligible Linear issues using healthy Codex profiles and queues the rest", async () => {
  const started: Array<{ taskId: string; profileId: string }> = [];
  const service = new OrchestrationService({
    now: () => new Date("2026-05-01T10:00:00.000Z"),
    getLinearConfig: async () => linearConfig(),
    syncLinear: async () => [task("a", { priority: 3 }), task("b", { priority: 1 }), task("c", { priority: 2 })],
    listProfiles: async () => [profile("p1"), profile("p2")],
    checkProfileHealth: async (candidate): Promise<HealthCheckResult> => ({
      ok: candidate.id !== "p1",
      label: candidate.name,
      detail: "ok",
      checkedAt: "2026-05-01T10:00:00.000Z"
    }),
    listRuns: async () => [],
    startRun: async (candidate, selectedProfile): Promise<Run> => {
      started.push({ taskId: candidate.id, profileId: selectedProfile.id });
      return {
        id: `run-${candidate.externalId}`,
        taskId: candidate.id,
        profileId: selectedProfile.id,
        state: "running",
        updatedAt: "2026-05-01T10:00:00.000Z"
      };
    }
  });

  await service.tick();

  expect(started).toEqual([
    { taskId: "linear:b", profileId: "p2" },
    { taskId: "linear:c", profileId: "p2" }
  ]);
  expect(service.snapshot()).toMatchObject({
    enabled: false,
    running: [
      { id: "run-b", taskId: "linear:b", profileId: "p2" },
      { id: "run-c", taskId: "linear:c", profileId: "p2" }
    ],
    queuedTaskIds: ["linear:a"]
  });
});

test("does not dispatch Todo issues with non-terminal blockers", async () => {
  const started: string[] = [];
  const service = new OrchestrationService({
    now: () => new Date("2026-05-01T10:00:00.000Z"),
    getLinearConfig: async () => linearConfig(),
    syncLinear: async () => [
      task("blocked", {
        status: "Todo",
        blockers: [{ id: "dep", identifier: "ENG-1", state: "In Progress" }]
      }),
      task("ready")
    ],
    listProfiles: async () => [profile("p1")],
    checkProfileHealth: async (): Promise<HealthCheckResult> => ({
      ok: true,
      label: "p1",
      detail: "ok",
      checkedAt: "2026-05-01T10:00:00.000Z"
    }),
    listRuns: async () => [],
    startRun: async (candidate, selectedProfile): Promise<Run> => {
      started.push(candidate.id);
      return {
        id: `run-${candidate.externalId}`,
        taskId: candidate.id,
        profileId: selectedProfile.id,
        state: "running",
        updatedAt: "2026-05-01T10:00:00.000Z"
      };
    }
  });

  await service.tick();

  expect(started).toEqual(["linear:ready"]);
  expect(service.snapshot().queuedTaskIds).toContain("linear:blocked");
});
