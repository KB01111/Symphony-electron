import { expect, test } from "vitest";
import { Scheduler } from "../src/main/services/scheduler.js";
import type { Task } from "../src/shared/types.js";

function task(id: string): Task {
  return {
    id,
    source: "linear",
    externalId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    description: "",
    status: "Ready",
    priority: 0,
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
}

test("starts no more than the configured concurrency", async () => {
  const started: string[] = [];
  const scheduler = new Scheduler({
    concurrency: 2,
    runTask: async (candidate) => {
      started.push(candidate.id);
      return { id: `run-${candidate.id}`, taskId: candidate.id };
    }
  });

  await scheduler.tick([task("a"), task("b"), task("c")]);

  expect(started).toEqual(["a", "b"]);
  expect(scheduler.snapshot().queuedTaskIds).toEqual(["c"]);
});

test("retries transient failures with capped exponential backoff", async () => {
  let attempts = 0;
  const scheduler = new Scheduler({
    concurrency: 1,
    now: () => new Date("2026-05-01T10:00:00.000Z"),
    runTask: async (candidate) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return { id: `run-${candidate.id}`, taskId: candidate.id };
    }
  });

  await scheduler.tick([task("a")]);
  expect(scheduler.snapshot().retryQueue[0]).toMatchObject({ taskId: "a", attempts: 1, nextAttemptAt: "2026-05-01T10:00:02.000Z" });

  await scheduler.tick([task("a")], new Date("2026-05-01T10:00:02.000Z"));
  expect(scheduler.snapshot().activeRuns).toEqual([{ id: "run-a", taskId: "a" }]);
});

