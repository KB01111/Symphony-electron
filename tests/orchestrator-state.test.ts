import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { OrchestratorStateStore } from "../src/main/services/orchestrator-state.js";

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
