import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ApprovalService } from "../src/main/services/approval-service.js";
import { JsonlEventLog } from "../src/main/services/event-log.js";
import { approvalResponseFor, isApprovalRequestMethod } from "../src/main/services/run-service.js";
import { RunService } from "../src/main/services/run-service.js";
import { WorkspaceManager } from "../src/main/services/workspace-manager.js";
import type { ApprovalRequest, Profile, Task } from "../src/shared/types.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-run-service-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function profile(root: string): Profile {
  return {
    id: "profile-1",
    name: "Profile 1",
    codexHome: path.join(root, "codex-home"),
    workspaceRoot: path.join(root, "workspaces"),
    repoCacheRoot: path.join(root, "repos"),
    logsRoot: path.join(root, "logs"),
    createdAt: "2026-05-02T10:00:00.000Z",
    updatedAt: "2026-05-02T10:00:00.000Z"
  };
}

function task(): Task {
  return {
    id: "linear:lin-1",
    source: "linear",
    externalId: "lin-1",
    identifier: "LIN-1",
    title: "Implement orchestration",
    description: "",
    status: "Ready",
    priority: 1,
    updatedAt: "2026-05-02T10:00:00.000Z"
  };
}

test("approval detector only accepts explicit request approval method names", () => {
  expect(isApprovalRequestMethod("item/commandExecution/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("item/fileChange/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("item/permissions/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("tool/request_approval")).toBe(true);
  expect(isApprovalRequestMethod("requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("applyPatchApproval")).toBe(true);
  expect(isApprovalRequestMethod("execCommandApproval")).toBe(true);

  expect(isApprovalRequestMethod("outputDelta")).toBe(false);
  expect(isApprovalRequestMethod("patchUpdated")).toBe(false);
  expect(isApprovalRequestMethod("item/commandExecution/started")).toBe(false);
  expect(isApprovalRequestMethod("approvalStatusUpdated")).toBe(false);
});

test("approval responses support singular permission method names", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    runId: "run-1",
    protocolRequestId: "request-1",
    protocolMethod: "requestPermission",
    kind: "network",
    title: "Approve network access",
    detail: "network",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: {
      id: "request-1",
      method: "requestPermission",
      params: {
        permissions: {
          network: true
        }
      }
    }
  };

  expect(approvalResponseFor(approval, true)).toEqual({
    permissions: {
      network: true
    },
    scope: "turn",
    strictAutoReview: true
  });
});

test("cancelled runs resolve pending approval waiters and deny persisted approvals", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "Handle {{identifier}}");
  const approvals = new ApprovalService(root);
  let requestApproval: ((requestId: string) => Promise<unknown>) | undefined;
  const service = new RunService(root, new JsonlEventLog(path.join(root, "logs")), new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    approvals,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        requestApproval = async (requestId: string) =>
          options.onServerRequest?.({
            id: requestId,
            method: "item/permissions/requestApproval",
            params: { permissions: { network: true } }
          });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      close: vi.fn()
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(() => expect(requestApproval).toBeDefined());
  const pendingResponse = requestApproval?.("approval-1");
  await vi.waitFor(async () => expect(await approvals.listPending()).toHaveLength(1));

  await service.cancel(run.id);

  await expect(pendingResponse).resolves.toEqual({ permissions: {}, scope: "turn", strictAutoReview: true });
  expect(await approvals.listPending()).toEqual([]);
  expect(await approvals.listForRun(run.id)).toMatchObject([{ status: "denied" }]);
});
