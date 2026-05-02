import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProofStore } from "../src/main/services/proof-store.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-proof-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("stores proof entries per run in creation order", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");

  await store.add("run-1", { kind: "test", label: "npm test", status: "passed", detail: "42 passed" });
  await store.add("run-1", { kind: "summary", label: "Final summary", status: "unknown", detail: "Ready for review" });

  expect(await store.list("run-1")).toMatchObject([
    { runId: "run-1", kind: "test", label: "npm test", status: "passed", detail: "42 passed" },
    { runId: "run-1", kind: "summary", label: "Final summary", status: "unknown", detail: "Ready for review" }
  ]);
  expect(await store.list("run-2")).toEqual([]);
});

test("serializes concurrent writes for the same runId without losing entries", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");
  const runId = "run-concurrent-1";

  const entries = Array.from({ length: 10 }, (_, i) => ({
    kind: "test" as const,
    label: `step-${i}`,
    status: i % 2 === 0 ? ("passed" as const) : ("failed" as const),
    detail: `detail-${i}`
  }));

  // Fire all adds concurrently; ProofStore.writeQueue should serialize them
  await Promise.all(entries.map((entry) => store.add(runId, entry)));

  const stored = await store.list(runId);

  // All entries should be present
  expect(stored).toHaveLength(entries.length);

  // Order should be consistent with the order in which add() was scheduled
  expect(stored).toMatchObject(
    entries.map((entry) => ({
      runId,
      ...entry
    }))
  );
});
