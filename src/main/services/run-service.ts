import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ApprovalKind, ApprovalRequest, Profile, Run, Task } from "../../shared/types.js";
import type { JsonRpcId } from "./codex-jsonrpc.js";
import { ApprovalStore } from "./approval-store.js";
import { FileStateStore } from "./file-state.js";
import { JsonlEventLog, type RunEventInput } from "./event-log.js";
import { isoNow } from "./time.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { CodexAppServerProcess } from "./codex-app-server.js";

const execFileAsync = promisify(execFile);

export class RunService {
  private readonly store: FileStateStore<Run[]>;
  private readonly active = new Map<string, CodexAppServerProcess>();

  constructor(
    appDataRoot: string,
    private readonly eventLog: JsonlEventLog,
    private readonly workspaceManager: WorkspaceManager,
    private readonly approvals: ApprovalStore
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
    const cancelled = await this.patch(runId, { state: "cancelled", completedAt: isoNow() });
    await this.eventLog.append(runId, { type: "run.cancelled", message: "Run cancelled by operator." });
    return cancelled;
  }

  async retry(run: Run, task: Task, profile: Profile): Promise<Run> {
    await this.eventLog.append(run.id, { type: "run.retry", message: "Retry requested; starting a new Codex app-server session." });
    return this.start(task, profile);
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

      const process = new CodexAppServerProcess({
        codexHome: profile.codexHome,
        cwd: workspace.path,
        onStdout: (chunk) => void this.eventLog.append(run.id, { type: "codex.stdout", stream: "stdout", message: chunk }),
        onStderr: (chunk) => void this.eventLog.append(run.id, { type: "codex.stderr", stream: "stderr", message: chunk }),
        onNotification: (method, params) => void this.handleNotification(run, method, params),
        onRequest: (method, params, id) => void this.handleRequest(run, method, params, id),
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
      await process.startTurn(workspace.workflowPrompt, workspace.path);
    } catch (error) {
      this.active.delete(run.id);
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
    if (run.state === "cancelled" || run.state === "done" || run.state === "failed") return;
    const failed = exitCode !== 0;
    await this.patch(runId, {
      state: failed ? "failed" : "review",
      completedAt: isoNow(),
      ...(failed ? { failureReason: `Codex app-server exited with code ${String(exitCode)} signal ${String(signal)}.` } : {}),
      updatedAt: isoNow()
    });
    await this.eventLog.append(runId, {
      type: failed ? "run.failed" : "run.review",
      message: failed ? `Codex app-server exited with ${String(exitCode)}.` : "Codex app-server exited; run is ready for review."
    });
  }

  private async handleNotification(run: Run, method: string, params: unknown): Promise<void> {
    await this.safeAppendEvent(run.id, { type: `codex.${method}`, payload: params });
    if (!isApprovalRequestMethod(method)) return;
    await this.captureApproval(run, method, params);
  }

  async respondToApproval(request: ApprovalRequest, approved: boolean): Promise<void> {
    if (request.protocolRequestId === undefined || !request.protocolMethod) return;
    const process = this.active.get(request.runId);
    if (!process) {
      throw new Error(`Cannot respond to approval for inactive run: ${request.runId}`);
    }
    process.respondToRequest(request.protocolRequestId, approvalResponseFor(request.protocolMethod, request.payload, approved));
  }

  private async handleRequest(run: Run, method: string, params: unknown, id: JsonRpcId): Promise<void> {
    await this.safeAppendEvent(run.id, { type: `codex.${method}`, payload: { requestId: id, params } });
    if (!isApprovalRequestMethod(method)) return;
    await this.captureApproval(run, method, params, id);
  }

  private async captureApproval(run: Run, method: string, params: unknown, protocolRequestId?: JsonRpcId): Promise<void> {
    try {
      await this.approvals.create({
        runId: run.id,
        ...(protocolRequestId === undefined ? {} : { protocolRequestId, protocolMethod: method }),
        kind: inferApprovalKind(method, params),
        title: method,
        detail: stringifyApprovalDetail(params),
        payload: params
      });
    } catch (error) {
      await this.safeAppendEvent(run.id, {
        type: "approval.capture_failed",
        message: (error as Error).message,
        payload: { method, params }
      });
    }
  }

  private async safeAppendEvent(runId: string, input: RunEventInput): Promise<void> {
    try {
      await this.eventLog.append(runId, input);
    } catch {
      // Approval capture and Codex event handling must not break the running session.
    }
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

function inferApprovalKind(method: string, _params: unknown): ApprovalKind {
  const normalized = method.toLowerCase();
  if (normalized.includes("command")) return "command";
  if (normalized.includes("file_change") || normalized.includes("filechange") || normalized.includes("patch")) return "patch";
  if (normalized.includes("network")) return "network";
  return "unknown";
}

function stringifyApprovalDetail(params: unknown): string {
  return (JSON.stringify(params, null, 2) ?? "").slice(0, 4000);
}

function approvalResponseFor(method: string, params: unknown, approved: boolean): unknown {
  const normalized = method.toLowerCase();
  if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (normalized.includes("commandexecution")) {
    return { decision: approved ? "accept" : "decline" };
  }
  if (normalized.includes("filechange")) {
    return { decision: approved ? "accept" : "decline" };
  }
  if (normalized.includes("permissions")) {
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
  return { decision: approved ? "accept" : "decline" };
}
