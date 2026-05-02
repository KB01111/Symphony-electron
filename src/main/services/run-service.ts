import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, Profile, ProofInput, ProofKind, ProofStatus, Run, RunTranscriptItem, Task } from "../../shared/types.js";
import { eventToTranscriptItem } from "../../shared/transcript.js";
import { FileStateStore } from "./file-state.js";
import { JsonlEventLog } from "./event-log.js";
import { isoNow } from "./time.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { CodexAppServerProcess, type CodexAppServerProcessFactory, type CodexAppServerProcessLike } from "./codex-app-server.js";
import { ApprovalService } from "./approval-service.js";
import { ProofStore } from "./proof-store.js";
import type { JsonRpcRequest } from "./codex-jsonrpc.js";

const execFileAsync = promisify(execFile);

interface RunServiceOptions {
  approvals?: ApprovalService;
  proof?: ProofStore;
  onRunNeedsReview?(run: Run): Promise<void>;
  onLinearGraphql?(payload: { query: string; variables?: Record<string, unknown> }): Promise<unknown>;
  createCodexProcess?: CodexAppServerProcessFactory;
}

export class RunService {
  private readonly store: FileStateStore<Run[]>;
  private readonly active = new Map<string, CodexAppServerProcessLike>();
  private readonly approvalWaiters = new Map<string, { runId: string; resolve(response: unknown): void }>();
  private readonly notificationQueues = new Map<string, Promise<void>>();

  constructor(
    appDataRoot: string,
    private readonly eventLog: JsonlEventLog,
    private readonly workspaceManager: WorkspaceManager,
    private readonly options: RunServiceOptions = {}
  ) {
    this.store = new FileStateStore<Run[]>(path.join(appDataRoot, "state", "runs.json"), []);
  }

  async list(): Promise<Run[]> {
    return this.store.read();
  }

  async start(task: Task, profile: Profile): Promise<Run> {
    const now = isoNow();
    const run: Run = {
      id: `run-${randomUUID().slice(0, 12)}`,
      taskId: task.id,
      profileId: profile.id,
      state: "preparing",
      updatedAt: now,
      startedAt: now
    };
    await this.upsert(run);
    await this.eventLog.append(run.id, { type: "run.preparing", message: `Preparing workspace for ${task.identifier}.` });

    void this.driveRun(run, task, profile);
    return run;
  }

  async cancel(runId: string): Promise<Run> {
    const run = await this.get(runId);
    const process = this.active.get(runId);
    if (process?.pid) {
      try {
        await execFileAsync("taskkill", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        process.close();
      }
    }
    this.active.delete(runId);
    await this.cleanupApprovalWaitersForRun(runId);
    if (run.workspacePath) {
      await this.safeWorkspaceBeforeRemove(run.workspacePath);
    }
    const cancelled = await this.patch(runId, { state: "cancelled", completedAt: isoNow() });
    await this.eventLog.append(runId, { type: "run.cancelled", message: "Run cancelled by operator." });
    return cancelled;
  }

  async retry(run: Run, task: Task, profile: Profile): Promise<Run> {
    await this.eventLog.append(run.id, { type: "run.retry", message: "Retry requested; starting a new Codex app-server session." });
    return this.start(task, profile);
  }

  async listApprovals(runId?: string): Promise<ApprovalRequest[]> {
    const approvals = this.options.approvals;
    if (!approvals) return [];
    return runId ? approvals.listForRun(runId) : approvals.listPending();
  }

  async respondToApproval(requestId: string, approved: boolean): Promise<void> {
    const approvals = this.options.approvals;
    const waiter = this.approvalWaiters.get(requestId);
    let approval: ApprovalRequest | undefined;
    if (approvals) {
      try {
        approval = await approvals.resolve(requestId, approved);
      } catch (error) {
        if (!waiter) {
          throw error;
        }
      }
    }
    if (waiter) {
      this.approvalWaiters.delete(requestId);
      waiter.resolve(approval ? approvalResponseFor(approval, approved) : fallbackApprovalResponse(approved));
    }
    if (approval) {
      await this.eventLog.append(approval.runId, {
        type: "approval.responded",
        message: approved ? "Approval granted by operator." : "Approval denied by operator.",
        payload: approval
      });
    }
  }

  async getTranscript(runId: string): Promise<RunTranscriptItem[]> {
    return (await this.eventLog.replay(runId)).map((event) => eventToTranscriptItem(event));
  }

  async get(runId: string): Promise<Run> {
    const run = (await this.list()).find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  private async driveRun(run: Run, task: Task, profile: Profile): Promise<void> {
    try {
      const workspace = await this.workspaceManager.prepareWorkspace(profile, task);
      const running = await this.patch(run.id, {
        state: "running",
        workspacePath: workspace.path,
        updatedAt: isoNow()
      });
      await this.eventLog.append(run.id, { type: "run.running", message: `Workspace ready at ${workspace.path}.` });

      const createCodexProcess = this.options.createCodexProcess ?? ((options) => new CodexAppServerProcess(options));
      const process = createCodexProcess({
        codexHome: profile.codexHome,
        cwd: workspace.path,
        command: workspace.runtime.command,
        approvalPolicy: workspace.runtime.approvalPolicy,
        sandbox: workspace.runtime.threadSandbox,
        readTimeoutMs: workspace.runtime.readTimeoutMs,
        onStdout: (chunk) => void this.eventLog.append(run.id, { type: "codex.stdout", stream: "stdout", message: chunk }),
        onStderr: (chunk) => void this.eventLog.append(run.id, { type: "codex.stderr", stream: "stderr", message: chunk }),
        onNotification: (method, params) => {
          const handled = this.enqueueNotification(run.id, () => this.handleCodexNotification(run.id, method, params));
          if (method === "turn/completed") {
            void handled.then(() => this.handleTurnCompleted(run.id));
          }
        },
        onServerRequest: (request) => this.handleServerRequest(run.id, request),
        onProtocolError: (error, chunk) =>
          void this.safeAppendEvent(run.id, {
            type: "codex.protocol_error",
            message: error.message,
            payload: { chunk }
          }),
        onExit: (exitCode, signal) => {
          this.active.delete(run.id);
          void this.handleExit(run.id, exitCode, signal);
        }
      });
      this.active.set(run.id, process);
      await this.patch(run.id, {
        ...running,
        ...(process.pid ? { pid: process.pid } : {}),
        updatedAt: isoNow()
      });
      const started = await process.startTurn(workspace.workflowPrompt, workspace.path);
      await this.patch(run.id, {
        threadId: started.threadId,
        turnId: started.turnId,
        updatedAt: isoNow()
      });
    } catch (error) {
      this.active.get(run.id)?.close();
      this.active.delete(run.id);
      await this.cleanupApprovalWaitersForRun(run.id);
      const failed = await this.get(run.id).catch(() => run);
      if (failed.workspacePath) {
        await this.safeWorkspaceAfterRun(failed.workspacePath);
      }
      await this.patch(run.id, {
        state: "failed",
        completedAt: isoNow(),
        failureReason: (error as Error).message,
        updatedAt: isoNow()
      });
      await this.eventLog.append(run.id, { type: "run.failed", message: (error as Error).message });
    }
  }

  private async handleExit(runId: string, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const run = await this.get(runId);
    if (run.state === "cancelled" || run.state === "done" || run.state === "failed" || run.state === "review") return;
    await this.cleanupApprovalWaitersForRun(runId);
    if (run.workspacePath) {
      await this.safeWorkspaceAfterRun(run.workspacePath);
    }
    const failed = exitCode !== 0;
    await this.patch(runId, {
      state: failed ? "failed" : "review",
      completedAt: isoNow(),
      ...(failed ? { failureReason: `Codex app-server exited with code ${String(exitCode)} signal ${String(signal)}.` } : {}),
      updatedAt: isoNow()
    });
    if (!failed) {
      const updated = await this.get(runId);
      await this.options.onRunNeedsReview?.(updated);
    }
    await this.eventLog.append(runId, {
      type: failed ? "run.failed" : "run.review",
      message: failed ? `Codex app-server exited with ${String(exitCode)}.` : "Codex app-server exited; run is ready for review."
    });
  }

  private async handleTurnCompleted(runId: string): Promise<void> {
    const run = await this.get(runId);
    if (run.state === "cancelled" || run.state === "done" || run.state === "failed" || run.state === "review") return;
    await this.addProof(runId, {
      kind: "summary",
      label: "Codex turn completed",
      status: "passed",
      detail: "The Codex app-server turn completed and the run is ready for Human Review."
    });
    const reviewed = await this.patch(runId, {
      state: "review",
      completedAt: isoNow(),
      updatedAt: isoNow()
    });
    if (reviewed.workspacePath) {
      await this.safeWorkspaceAfterRun(reviewed.workspacePath);
    }
    await this.eventLog.append(runId, { type: "run.review", message: "Codex turn completed; run is ready for review." });
    await this.options.onRunNeedsReview?.(reviewed);
    const process = this.active.get(runId);
    this.active.delete(runId);
    await this.cleanupApprovalWaitersForRun(runId);
    process?.close();
  }

  private async patch(runId: string, patch: Partial<Run>): Promise<Run> {
    const run = await this.get(runId);
    const updated = { ...run, ...patch, updatedAt: patch.updatedAt ?? isoNow() };
    await this.upsert(updated);
    return updated;
  }

  private async upsert(run: Run): Promise<void> {
    const runs = await this.store.read();
    const index = runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) {
      runs[index] = run;
    } else {
      runs.push(run);
    }
    await this.store.write(runs);
  }

  private async handleServerRequest(runId: string, request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "item/tool/call") {
      return this.handleDynamicToolCall(request);
    }

    if (isApprovalRequestMethod(request.method)) {
      const approval = await this.createApproval(runId, request);
      await this.eventLog.append(runId, { type: "run.approval.requested", message: approval.title, payload: approval });
      return new Promise((resolve) => {
        this.approvalWaiters.set(approval.id, { runId, resolve });
      });
    }

    throw new Error(`Unsupported app-server request: ${request.method}`);
  }

  private async handleDynamicToolCall(request: JsonRpcRequest): Promise<unknown> {
    const params = request.params as { tool?: string; arguments?: unknown };
    if (params.tool !== "linear_graphql") {
      throw new Error(`Unsupported dynamic tool: ${String(params.tool)}`);
    }
    if (!this.options.onLinearGraphql) {
      throw new Error("Linear GraphQL tool is not configured.");
    }
    const args = params.arguments as { query?: string; variables?: Record<string, unknown> };
    if (!args.query) {
      throw new Error("linear_graphql requires a query string.");
    }
    const payload: { query: string; variables?: Record<string, unknown> } = { query: args.query };
    if (args.variables) {
      payload.variables = args.variables;
    }
    const result = await this.options.onLinearGraphql(payload);
    return {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(result, null, 2) }]
    };
  }

  private async createApproval(runId: string, request: JsonRpcRequest): Promise<ApprovalRequest> {
    const approvals = this.options.approvals;
    if (!approvals) {
      throw new Error("Approval storage is not configured.");
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    const kind = inferApprovalKind(request.method, params);
    const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : undefined;
    const detail = command ?? (typeof params.reason === "string" ? params.reason : stringifyApprovalDetail(params));
    return approvals.create({
      runId,
      protocolRequestId: request.id,
      protocolMethod: request.method,
      kind,
      title: approvalTitle(kind),
      detail,
      payload: request
    });
  }

  private async safeAppendEvent(runId: string, input: Parameters<JsonlEventLog["append"]>[1]): Promise<void> {
    try {
      await this.eventLog.append(runId, input);
    } catch {
      // Protocol error capture must not break the running session.
    }
  }

  private async handleCodexNotification(runId: string, method: string, params: unknown): Promise<void> {
    await this.eventLog.append(runId, { type: `codex.${method}`, payload: params });
    const lowerMethod = method.toLowerCase();
    if (lowerMethod.includes("tokenusage")) {
      await this.addProof(runId, {
        kind: "token_usage",
        label: "Token usage",
        status: "unknown",
        detail: stringifyProofDetail(params)
      });
      return;
    }
    if (lowerMethod.includes("ratelimit")) {
      await this.addProof(runId, {
        kind: "rate_limit",
        label: "Rate limit",
        status: "warning",
        detail: stringifyProofDetail(params)
      });
      return;
    }
    const kind = inferProofKind(method);
    if (!kind) return;
    await this.addProof(runId, {
      kind,
      label: method,
      status: inferProofStatus(params),
      detail: stringifyProofDetail(params)
    });
  }

  private enqueueNotification(runId: string, operation: () => Promise<void>): Promise<void> {
    const current = this.notificationQueues.get(runId) ?? Promise.resolve();
    const next = current.then(operation, operation);
    this.notificationQueues.set(
      runId,
      next.finally(() => {
        if (this.notificationQueues.get(runId) === next) {
          this.notificationQueues.delete(runId);
        }
      })
    );
    return next;
  }

  private async addProof(runId: string, input: ProofInput): Promise<void> {
    await this.options.proof?.add(runId, input);
  }

  private async safeWorkspaceAfterRun(workspacePath: string): Promise<void> {
    try {
      await this.workspaceManager.afterRun(workspacePath);
    } catch {
      // Hook failures after a run should not mask the original run result.
    }
  }

  private async safeWorkspaceBeforeRemove(workspacePath: string): Promise<void> {
    try {
      await this.workspaceManager.beforeRemove(workspacePath);
    } catch {
      // Cleanup hooks must not block explicit cancellation.
    }
  }

  private async cleanupApprovalWaitersForRun(runId: string): Promise<void> {
    const approvals = this.options.approvals;
    const pending = approvals ? (await approvals.listForRun(runId)).filter((approval) => approval.status === "pending") : [];
    const pendingById = new Map(pending.map((approval) => [approval.id, approval]));
    for (const [approvalId, waiter] of this.approvalWaiters) {
      if (waiter.runId === runId) {
        this.approvalWaiters.delete(approvalId);
        const approval = pendingById.get(approvalId);
        waiter.resolve(approval ? approvalResponseFor(approval, false) : fallbackApprovalResponse(false));
      }
    }
    if (!approvals) return;
    await Promise.all(
      pending.map(async (approval) => {
        try {
          await approvals.resolve(approval.id, false);
        } catch {
          // Approval may already have been resolved by the operator.
        }
      })
    );
  }
}

export function isApprovalRequestMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return (
    normalized === "requestapproval" ||
    normalized === "request_approval" ||
    normalized === "applypatchapproval" ||
    normalized === "execcommandapproval" ||
    normalized.endsWith("/requestapproval") ||
    normalized.endsWith("/request_approval")
  );
}

function inferApprovalKind(method: string, params: Record<string, unknown>): ApprovalRequest["kind"] {
  const normalized = method.toLowerCase();
  if (normalized.includes("command") || normalized === "execcommandapproval") return "command";
  if (normalized.includes("file_change") || normalized.includes("filechange") || normalized.includes("patch")) return "patch";
  if (normalized.includes("network")) return "network";
  if (normalized.includes("permission")) {
    const permissions = params.permissions as { network?: unknown; fileSystem?: unknown } | undefined;
    if (permissions?.network) return "network";
    if (permissions?.fileSystem) return "filesystem";
  }
  if (normalized.includes("tool")) return "tool";
  return "unknown";
}

function approvalTitle(kind: ApprovalRequest["kind"]): string {
  switch (kind) {
    case "patch":
      return "Approve file changes";
    case "tool":
      return "Approve tool request";
    case "network":
      return "Approve network access";
    case "filesystem":
      return "Approve filesystem access";
    case "command":
      return "Approve command";
    default:
      return "Approve Codex request";
  }
}

function stringifyApprovalDetail(params: unknown): string {
  return (JSON.stringify(params, null, 2) ?? "").slice(0, 4000);
}

export function approvalResponseFor(approval: ApprovalRequest, approved: boolean): unknown {
  const request = approval.payload as Partial<JsonRpcRequest>;
  const method = typeof request.method === "string" ? request.method : "";
  const params = request.params;
  const normalized = method.toLowerCase();
  if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (normalized.includes("permission")) {
    const requested = params as { permissions?: { network?: unknown; fileSystem?: unknown } };
    return approved
      ? {
          permissions: {
            ...(requested.permissions?.network ? { network: requested.permissions.network } : {}),
            ...(requested.permissions?.fileSystem ? { fileSystem: requested.permissions.fileSystem } : {})
          },
          scope: "turn",
          strictAutoReview: true
        }
      : { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (approval.kind === "tool") {
    return { answers: {} };
  }
  return { decision: approved ? "accept" : "decline" };
}

/**
 * Create a protocol response object representing an approval decision.
 *
 * @param approved - `true` if the request was approved by an operator, `false` otherwise
 * @returns An object with a `decision` property set to `"accept"` when `approved` is `true` and `"decline"` when `approved` is `false`
 */
function fallbackApprovalResponse(approved: boolean): unknown {
  return { decision: approved ? "accept" : "decline" };
}

/**
 * Infers a proof kind from a Codex notification or protocol method name.
 *
 * @param method - The notification or method string to inspect
 * @returns The matching `ProofKind` (`"test"`, `"ci"`, `"review"`, `"diff"`, or `"pr"`) if the method indicates one; otherwise `undefined`
 */
function inferProofKind(method: string): ProofKind | undefined {
  const normalized = method.toLowerCase();
  if (normalized.includes("test")) return "test";
  if (normalized.includes("ci")) return "ci";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("diff")) return "diff";
  if (normalized.includes("pullrequest") || normalized.includes("pr")) return "pr";
  return undefined;
}

/**
 * Infers a proof status from the textual content of an arbitrary value.
 *
 * @param value - The value whose string form will be inspected for status keywords
 * @returns `failed`, `passed`, `warning`, or `unknown` depending on which keywords (`failed`/`failure`/`error`, `passed`/`success`/`completed`, `warning`/`warn`) appear in the stringified `value` (case-insensitive)
 */
function inferProofStatus(value: unknown): ProofStatus {
  const text = stringifyProofDetail(value).toLowerCase();
  if (text.includes("failed") || text.includes("failure") || text.includes("error")) return "failed";
  if (text.includes("passed") || text.includes("success") || text.includes("completed")) return "passed";
  if (text.includes("warning") || text.includes("warn")) return "warning";
  return "unknown";
}

/**
 * Convert a value to a pretty-printed JSON string and truncate it to 2000 characters.
 *
 * @param value - The proof payload to serialize
 * @returns The JSON representation of `value` with 2-space indentation, limited to 2000 characters
 */
function stringifyProofDetail(value: unknown): string {
  return (JSON.stringify(value, null, 2) ?? "").slice(0, 2000);
}
