import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ApprovalStore } from "../src/main/services/approval-store.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-approvals-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("captures pending approval requests and records decisions", async () => {
  const store = new ApprovalStore(await tempRoot());
  const request = await store.create({
    runId: "run-1",
    kind: "command",
    title: "Run npm test",
    detail: "npm test",
    payload: { command: "npm test" }
  });

  expect((await store.listPending()).map((item) => item.id)).toEqual([request.id]);

  await store.respond(request.id, true);
  expect(await store.listPending()).toEqual([]);
  expect((await store.list()).find((item) => item.id === request.id)).toMatchObject({ approved: true });
});
