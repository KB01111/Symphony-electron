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
    protocolRequestId: "protocol-1",
    protocolMethod: "item/commandExecution/requestApproval",
    kind: "command",
    title: "Run npm test",
    detail: "npm test",
    payload: { command: "npm test" }
  });

  expect((await store.listPending()).map((item) => item.id)).toEqual([request.id]);

  await store.respond(request.id, true);
  expect(await store.listPending()).toEqual([]);
  expect((await store.list()).find((item) => item.id === request.id)).toMatchObject({
    approved: true,
    protocolRequestId: "protocol-1",
    protocolMethod: "item/commandExecution/requestApproval"
  });
});

test("throws when responding to an unknown approval request", async () => {
  const store = new ApprovalStore(await tempRoot());

  await expect(store.respond("approval-missing", true)).rejects.toThrow("Unknown approval request: approval-missing");
});

test("lists approvals filtered by run id", async () => {
  const store = new ApprovalStore(await tempRoot());
  const run1 = await store.create({
    runId: "run-1",
    kind: "command",
    title: "Run tests",
    detail: "npm test",
    payload: { command: "npm test" }
  });
  await store.create({
    runId: "run-2",
    kind: "patch",
    title: "Apply patch",
    detail: "patch",
    payload: { path: "src/app.ts" }
  });

  expect(await store.list("run-1")).toEqual([run1]);
});

test("persists approvals across store instances and records rejected decisions", async () => {
  const root = await tempRoot();
  const store = new ApprovalStore(root);
  const request = await store.create({
    runId: "run-1",
    kind: "network",
    title: "Fetch",
    detail: "curl example.com",
    payload: { host: "example.com" }
  });

  await store.respond(request.id, false);

  const reloaded = new ApprovalStore(root);
  expect(await reloaded.list()).toMatchObject([
    {
      id: request.id,
      runId: "run-1",
      approved: false
    }
  ]);
});

test("does not lose concurrent approval creates", async () => {
  const store = new ApprovalStore(await tempRoot());

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.create({
        runId: index % 2 === 0 ? "run-even" : "run-odd",
        kind: "command",
        title: `Command ${index}`,
        detail: `command-${index}`,
        payload: { index }
      })
    )
  );

  expect(await store.list()).toHaveLength(20);
  expect(await store.list("run-even")).toHaveLength(10);
});
