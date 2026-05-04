import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ApprovalService } from "../src/main/services/approval-service.js";
import { JsonlEventLog } from "../src/main/services/event-log.js";
import { ProofStore } from "../src/main/services/proof-store.js";
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
      continueTurn: async () => ({ threadId: "thread-1", turnId: "turn-2" }),
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

test("approvalResponseFor returns approved/denied for execCommandApproval", () => {
  const approval: ApprovalRequest = {
    id: "a1",
    runId: "run-1",
    protocolRequestId: "req-1",
    protocolMethod: "execCommandApproval",
    kind: "command",
    title: "Run shell command",
    detail: "rm -rf /tmp/test",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: { id: "req-1", method: "execCommandApproval", params: {} }
  };

  expect(approvalResponseFor(approval, true)).toEqual({ decision: "approved" });
  expect(approvalResponseFor(approval, false)).toEqual({ decision: "denied" });
});

test("approvalResponseFor returns approved/denied for applyPatchApproval", () => {
  const approval: ApprovalRequest = {
    id: "a2",
    runId: "run-1",
    protocolRequestId: "req-2",
    protocolMethod: "applyPatchApproval",
    kind: "patch",
    title: "Apply patch",
    detail: "diff --git ...",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: { id: "req-2", method: "applyPatchApproval", params: {} }
  };

  expect(approvalResponseFor(approval, true)).toEqual({ decision: "approved" });
  expect(approvalResponseFor(approval, false)).toEqual({ decision: "denied" });
});

test("approvalResponseFor returns empty permissions when permission request is denied", () => {
  const approval: ApprovalRequest = {
    id: "a3",
    runId: "run-1",
    protocolRequestId: "req-3",
    protocolMethod: "requestPermission",
    kind: "network",
    title: "Network access",
    detail: "api.example.com",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: {
      id: "req-3",
      method: "requestPermission",
      params: { permissions: { network: true } }
    }
  };

  expect(approvalResponseFor(approval, false)).toEqual({ permissions: {}, scope: "turn", strictAutoReview: true });
});

test("approvalResponseFor returns answers object for tool kind", () => {
  const approval: ApprovalRequest = {
    id: "a4",
    runId: "run-1",
    protocolRequestId: "req-4",
    protocolMethod: "someTool",
    kind: "tool",
    title: "Tool approval",
    detail: "Use linear_graphql",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: { id: "req-4", method: "someTool", params: {} }
  };

  expect(approvalResponseFor(approval, true)).toEqual({ answers: {} });
  expect(approvalResponseFor(approval, false)).toEqual({ answers: {} });
});

test("approvalResponseFor returns accept/decline fallback for unrecognized method and non-tool kind", () => {
  const approval: ApprovalRequest = {
    id: "a5",
    runId: "run-1",
    protocolRequestId: "req-5",
    protocolMethod: "unknownMethod",
    kind: "command",
    title: "Unknown",
    detail: "?",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: { id: "req-5", method: "unknownMethod", params: {} }
  };

  expect(approvalResponseFor(approval, true)).toEqual({ decision: "accept" });
  expect(approvalResponseFor(approval, false)).toEqual({ decision: "decline" });
});

test("approvalResponseFor selects only provided permissions fields when approved", () => {
  const approval: ApprovalRequest = {
    id: "a6",
    runId: "run-1",
    protocolRequestId: "req-6",
    protocolMethod: "requestPermission",
    kind: "network",
    title: "FS access",
    detail: "/home/user",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: {
      id: "req-6",
      method: "requestPermission",
      params: { permissions: { fileSystem: { read: true } } }
    }
  };

  expect(approvalResponseFor(approval, true)).toEqual({
    permissions: { fileSystem: { read: true } },
    scope: "turn",
    strictAutoReview: true
  });
});

test("records proof from Codex notifications and marks completed turns for review", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "Handle {{identifier}}");
  const proof = new ProofStore(root, () => "2026-05-02T10:00:00.000Z");
  const service = new RunService(root, new JsonlEventLog(path.join(root, "logs")), new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    proof,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        options.onNotification?.("thread/tokenUsageUpdated", {
          tokenUsage: {
            total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 30 },
            last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 30 },
            modelContextWindow: 128000
          }
        });
        options.onNotification?.("turn/completed", { turn: { id: "turn-1" } });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      continueTurn: async () => ({ threadId: "thread-1", turnId: "turn-2" }),
      close: vi.fn()
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(async () => expect((await service.get(run.id)).state).toBe("review"));

  expect(await proof.list(run.id)).toMatchObject([
    {
      kind: "token_usage",
      label: "Token usage",
      status: "unknown",
      detail: expect.stringContaining("totalTokens")
    },
    {
      kind: "summary",
      label: "Codex turn completed",
      status: "passed"
    }
  ]);
});

test("records inferred proof kinds from method names including test, ci, diff, and review", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "Handle {{identifier}}");
  const proof = new ProofStore(root, () => "2026-05-02T10:00:00.000Z");
  const service = new RunService(root, new JsonlEventLog(path.join(root, "logs")), new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    proof,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        options.onNotification?.("run/testCompleted", { status: "passed", count: 5 });
        options.onNotification?.("ci/pipelineUpdated", { status: "success" });
        options.onNotification?.("code/diffGenerated", { lines: 42 });
        options.onNotification?.("turn/completed", { turn: { id: "turn-1" } });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      continueTurn: async () => ({ threadId: "thread-1", turnId: "turn-2" }),
      close: vi.fn()
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(async () => expect((await service.get(run.id)).state).toBe("review"));

  const entries = await proof.list(run.id);
  const kinds = entries.map((e) => e.kind);
  expect(kinds).toContain("test");
  expect(kinds).toContain("ci");
  expect(kinds).toContain("diff");
});

test("continues Codex turns while tracker issue remains active", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "---\nagent:\n  max_turns: 2\n---\nHandle {{identifier}}", "utf8");
  const turnIds: string[] = [];
  let completion: ((params?: unknown) => void) | undefined;
  let continueCompletion: ((params?: unknown) => void) | undefined;
  const service = new RunService(root, new JsonlEventLog(path.join(root, "logs")), new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    shouldContinueRun: async () => true,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        turnIds.push("turn-1");
        completion = (params?: unknown) => options.onNotification?.("turn/completed", params ?? { turn: { id: "turn-1" } });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      continueTurn: async () => {
        turnIds.push("turn-2");
        continueCompletion = (params?: unknown) => options.onNotification?.("turn/completed", params ?? { turn: { id: "turn-2" } });
        return { threadId: "thread-1", turnId: "turn-2" };
      },
      close: vi.fn()
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(() => expect(completion).toBeDefined());
  completion?.();
  await vi.waitFor(() => expect(continueCompletion).toBeDefined());
  continueCompletion?.();
  await vi.waitFor(async () => expect((await service.get(run.id)).state).toBe("review"));

  expect(turnIds).toEqual(["turn-1", "turn-2"]);
  expect(await service.get(run.id)).toMatchObject({ turnCount: 2, turnId: "turn-2", state: "review" });
});

test("marks the run failed when continuing a turn fails", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "---\nagent:\n  max_turns: 2\n---\nHandle {{identifier}}", "utf8");
  let completion: (() => void) | undefined;
  const close = vi.fn();
  const service = new RunService(root, new JsonlEventLog(path.join(root, "logs")), new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    shouldContinueRun: async () => true,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        completion = () => options.onNotification?.("turn/completed", { turn: { id: "turn-1" } });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      continueTurn: async () => {
        throw new Error("network unavailable");
      },
      close
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(() => expect(completion).toBeDefined());
  completion?.();

  await vi.waitFor(async () => expect(await service.get(run.id)).toMatchObject({ state: "failed", failureReason: "network unavailable" }));
  expect(close).toHaveBeenCalled();
});

test("continues completed turns even when notification recording fails", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "WORKFLOW.md"), "---\nagent:\n  max_turns: 2\n---\nHandle {{identifier}}", "utf8");
  let completion: (() => void) | undefined;
  const eventLog = new JsonlEventLog(path.join(root, "logs"));
  const append = vi.spyOn(eventLog, "append");
  append.mockImplementation(async (runId, input) => {
    if (input.type === "codex.turn/completed") {
      throw new Error("event log unavailable");
    }
    return Reflect.apply(JsonlEventLog.prototype.append, eventLog, [runId, input]);
  });
  const service = new RunService(root, eventLog, new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") }), {
    shouldContinueRun: async () => false,
    createCodexProcess: (options) => ({
      get pid() {
        return undefined;
      },
      startTurn: async () => {
        completion = () => options.onNotification?.("turn/completed", { turn: { id: "turn-1" } });
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      continueTurn: async () => ({ threadId: "thread-1", turnId: "turn-2" }),
      close: vi.fn()
    })
  });

  const run = await service.start(task(), profile(root));
  await vi.waitFor(() => expect(completion).toBeDefined());
  completion?.();

  await vi.waitFor(async () => expect(await service.get(run.id)).toMatchObject({ state: "review" }));
});
