import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ApprovalService } from "../src/main/services/approval-service.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-approval-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("stores pending approvals and marks operator decisions", async () => {
  const root = await tempRoot();
  const service = new ApprovalService(root);

  const approval = await service.create({
    runId: "run-1",
    protocolRequestId: 10,
    kind: "command",
    title: "Run command",
    detail: "npm test",
    payload: { command: "npm test" }
  });
  await service.resolve(approval.id, true);

  expect(await service.listPending()).toEqual([]);
  expect(await service.listForRun("run-1")).toMatchObject([{ id: approval.id, status: "approved" }]);
});
