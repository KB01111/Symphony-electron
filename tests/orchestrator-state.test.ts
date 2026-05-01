import { mkdtemp, rm } from "node:fs/promises";
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
