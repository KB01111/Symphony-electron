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

test("entries for different runs are stored together but listed independently", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");

  await store.add("run-1", { kind: "test", label: "run-1 test", status: "passed", detail: "ok" });
  await store.add("run-2", { kind: "ci", label: "run-2 ci", status: "failed", detail: "nope" });
  await store.add("run-1", { kind: "summary", label: "run-1 summary", status: "passed", detail: "done" });

  const run1 = await store.list("run-1");
  const run2 = await store.list("run-2");

  expect(run1).toHaveLength(2);
  expect(run1.every((e) => e.runId === "run-1")).toBe(true);
  expect(run2).toHaveLength(1);
  expect(run2[0].runId).toBe("run-2");
});

test("each entry receives a unique id", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");

  const a = await store.add("run-1", { kind: "test", label: "a", status: "passed", detail: "" });
  const b = await store.add("run-1", { kind: "test", label: "b", status: "passed", detail: "" });

  expect(a.id).not.toBe(b.id);
  expect(a.id).toMatch(/^proof-/);
  expect(b.id).toMatch(/^proof-/);
});

test("concurrent adds do not lose entries", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");

  await Promise.all([
    store.add("run-1", { kind: "test", label: "t1", status: "passed", detail: "" }),
    store.add("run-1", { kind: "ci", label: "t2", status: "passed", detail: "" }),
    store.add("run-1", { kind: "review", label: "t3", status: "passed", detail: "" })
  ]);

  const entries = await store.list("run-1");
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map((e) => e.label)).size).toBe(3);
});

test("returns empty array for run with no entries", async () => {
  const store = new ProofStore(await tempRoot(), () => "2026-05-02T10:00:00.000Z");
  expect(await store.list("nonexistent-run")).toEqual([]);
});
