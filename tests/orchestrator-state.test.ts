import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { defaultAutomationPolicy, defaultOrchestratorState, OrchestratorStateStore } from "../src/main/services/orchestrator-state.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-orchestrator-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("creates a default autonomous orchestrator state", async () => {
  const store = new OrchestratorStateStore(await tempRoot());
  const state = await store.read();

  expect(state.mode).toBe("autonomous");
  expect(state.paused).toBe(false);
  expect(state.policy.maxConcurrentRuns).toBe(2);
  expect(state.policy.autoStart).toBe(true);
  expect(state.policy.autoCreateHandoff).toBe(true);
  expect(state.retryQueue).toEqual([]);
});

test("updates state atomically and preserves retry entries", async () => {
  const store = new OrchestratorStateStore(await tempRoot());

  const updated = await store.update((state) => ({
    ...state,
    paused: true,
    retryQueue: [
      {
        taskId: "linear:lin-1",
        attempts: 2,
        nextAttemptAt: "2026-05-02T10:05:00.000Z",
        lastError: "temporary failure"
      }
    ]
  }));

  expect(updated.paused).toBe(true);
  expect((await store.read()).retryQueue[0]).toMatchObject({ attempts: 2, lastError: "temporary failure" });
});

test("serializes concurrent updates so independent mutations are preserved", async () => {
  const store = new OrchestratorStateStore(await tempRoot());

  await Promise.all([
    store.update((state) => ({
      ...state,
      paused: true
    })),
    store.update((state) => ({
      ...state,
      retryQueue: [
        {
          taskId: "linear:lin-1",
          attempts: 1,
          nextAttemptAt: "2026-05-02T10:05:00.000Z",
          lastError: "temporary failure"
        }
      ]
    }))
  ]);

  const state = await store.read();
  expect(state.paused).toBe(true);
  expect(state.retryQueue).toHaveLength(1);
});

test("backfills defaults when reading older partial orchestrator state", async () => {
  const root = await tempRoot();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "orchestrator.json"),
    JSON.stringify({
      mode: "manual",
      paused: true,
      policy: {
        autoStart: false,
        requireApprovalFor: ["command"]
      }
    }),
    "utf8"
  );

  const store = new OrchestratorStateStore(root);
  const state = await store.read();

  expect(state.mode).toBe("manual");
  expect(state.paused).toBe(true);
  expect(state.policy.autoStart).toBe(false);
  expect(state.policy.autoCreateHandoff).toBe(true);
  expect(state.policy.autoWriteTrackerUpdates).toBe(false);
  expect(state.policy.maxConcurrentRuns).toBe(2);
  expect(state.policy.pollIntervalSeconds).toBe(60);
  expect(state.policy.stallTimeoutSeconds).toBe(1800);
  expect(state.policy.maxRetryBackoffSeconds).toBe(300);
  expect(state.policy.terminalStateNames).toEqual(["Done", "Canceled", "Cancelled", "Duplicate"]);
  expect(state.policy.requireApprovalFor).toEqual(["command"]);
  expect(state.activeClaims).toEqual([]);
  expect(state.retryQueue).toEqual([]);
});

test("clones policy arrays for defaults and backfilled reads", async () => {
  const defaultState = defaultOrchestratorState();
  defaultState.policy.terminalStateNames.push("Mutated");
  defaultState.policy.requireApprovalFor.push("command");

  expect(defaultOrchestratorState().policy.terminalStateNames).toEqual(["Done", "Canceled", "Cancelled", "Duplicate"]);
  expect(defaultOrchestratorState().policy.requireApprovalFor).toEqual(["merge"]);

  const store = new OrchestratorStateStore(await tempRoot());
  const readState = await store.read();
  readState.policy.terminalStateNames.push("ReadMutated");
  readState.policy.requireApprovalFor.push("network");

  const laterState = await store.read();
  expect(laterState.policy.terminalStateNames).toEqual(["Done", "Canceled", "Cancelled", "Duplicate"]);
  expect(laterState.policy.requireApprovalFor).toEqual(["merge"]);
});

test("defaultAutomationPolicy includes maxConcurrentRunsByState as empty object", () => {
  expect(defaultAutomationPolicy).toHaveProperty("maxConcurrentRunsByState");
  expect(defaultAutomationPolicy.maxConcurrentRunsByState).toEqual({});
});

test("defaultOrchestratorState includes maxConcurrentRunsByState as empty object", () => {
  const state = defaultOrchestratorState();
  expect(state.policy.maxConcurrentRunsByState).toEqual({});
});

test("cloneAutomationPolicy does not share maxConcurrentRunsByState reference", () => {
  const a = defaultOrchestratorState();
  const b = defaultOrchestratorState();

  (a.policy.maxConcurrentRunsByState as Record<string, number>)["in_progress"] = 3;
  expect(b.policy.maxConcurrentRunsByState).not.toHaveProperty("in_progress");
});

test("cloneAutomationPolicy does not share allowedRepositories reference", () => {
  const a = defaultOrchestratorState();
  const b = defaultOrchestratorState();

  a.policy.allowedRepositories.push("https://github.com/acme/widgets");
  expect(b.policy.allowedRepositories).toEqual([]);
});

test("store read backfills maxConcurrentRunsByState default when missing from persisted state", async () => {
  const root = await tempRoot();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "orchestrator.json"),
    JSON.stringify({
      mode: "autonomous",
      paused: false,
      policy: {
        autoStart: true,
        maxConcurrentRuns: 1
        // intentionally omits maxConcurrentRunsByState
      }
    }),
    "utf8"
  );

  const store = new OrchestratorStateStore(root);
  const state = await store.read();

  expect(state.policy.maxConcurrentRunsByState).toEqual({});
});

test("clones maxConcurrentRunsByState from stored state so mutations do not corrupt future reads", async () => {
  const root = await tempRoot();
  const store = new OrchestratorStateStore(root);

  await store.update((state) => ({
    ...state,
    policy: {
      ...state.policy,
      maxConcurrentRunsByState: { ready: 2 }
    }
  }));

  const first = await store.read();
  (first.policy.maxConcurrentRunsByState as Record<string, number>)["ready"] = 99;

  const second = await store.read();
  expect(second.policy.maxConcurrentRunsByState["ready"]).toBe(2);
});
