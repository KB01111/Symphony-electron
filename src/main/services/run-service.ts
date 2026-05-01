import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Profile, Run, Task } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { JsonlEventLog } from "./event-log.js";
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
    private readonly workspaceManager: WorkspaceManager
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
        onNotification: (method, params) => void this.eventLog.append(run.id, { type: `codex.${method}`, payload: params }),
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
