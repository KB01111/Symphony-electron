import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodexRuntimeConfig, Profile, Task, WorkspaceRef } from "../../shared/types.js";
import { WorkflowService, type LoadedWorkflow } from "./workflow-service.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export class WorkspaceManager {
  private readonly workflow: WorkflowService | undefined;

  constructor(private readonly options: { workflowPath?: string; workflow?: WorkflowService } = {}) {
    this.workflow = options.workflow ?? (options.workflowPath ? new WorkflowService(options.workflowPath) : undefined);
  }

  async prepareWorkspace(profile: Profile, task: Task): Promise<WorkspaceRef> {
    const loadedWorkflow = await this.loadWorkflow();
    await mkdir(profile.workspaceRoot, { recursive: true });
    await mkdir(profile.repoCacheRoot, { recursive: true });
    const workspacePath = safeChildPath(profile.workspaceRoot, `${slugify(task.identifier)}-${slugify(task.externalId)}`);

    let repoCachePath: string | undefined;
    if (task.repositoryUrl) {
      repoCachePath = await this.ensureRepositoryCache(profile, task.repositoryUrl);
      if (!existsSync(workspacePath)) {
        await execFileAsync("git", ["--git-dir", repoCachePath, "worktree", "add", workspacePath], { windowsHide: true });
      }
    } else {
      await mkdir(workspacePath, { recursive: true });
    }

    await this.runHook(loadedWorkflow, "afterCreate", workspacePath);
    await this.runHook(loadedWorkflow, "beforeRun", workspacePath);

    const workflowPrompt = await this.renderWorkflowPrompt(task, loadedWorkflow);
    const promptPath = path.join(workspacePath, "SYMPHONY_TASK.md");
    await writeFile(promptPath, workflowPrompt, "utf8");

    return {
      path: workspacePath,
      promptPath,
      workflowPrompt,
      runtime: this.runtimeConfig(loadedWorkflow),
      ...(repoCachePath ? { repoCachePath } : {})
    };
  }

  async afterRun(workspacePath: string): Promise<void> {
    await this.runHook(await this.loadWorkflow(), "afterRun", workspacePath);
  }

  async beforeRemove(workspacePath: string): Promise<void> {
    await this.runHook(await this.loadWorkflow(), "beforeRemove", workspacePath);
  }

  private async ensureRepositoryCache(profile: Profile, repositoryUrl: string): Promise<string> {
    const cachePath = safeChildPath(profile.repoCacheRoot, `${slugify(repositoryUrl)}.git`);
    if (!existsSync(cachePath)) {
      await mkdir(profile.repoCacheRoot, { recursive: true });
      await execFileAsync("git", ["clone", "--mirror", repositoryUrl, cachePath], { windowsHide: true });
    } else {
      await execFileAsync("git", ["--git-dir", cachePath, "fetch", "--prune"], { windowsHide: true });
    }
    return cachePath;
  }

  private async renderWorkflowPrompt(task: Task, loadedWorkflow?: LoadedWorkflow | null): Promise<string> {
    if (this.workflow) {
      if (loadedWorkflow) {
        return this.workflow.renderPrompt(task);
      }
      return this.workflow.renderPrompt(task);
    }
    return [
      "# Symphony Task",
      "",
      `Identifier: ${task.identifier}`,
      `Title: ${task.title}`,
      "",
      task.description,
      "",
      "Work inside this isolated workspace. Preserve unrelated changes. Report verification clearly."
    ].join("\n");
  }

  private async loadWorkflow(): Promise<LoadedWorkflow | null> {
    return this.workflow ? this.workflow.load() : null;
  }

  private runtimeConfig(loadedWorkflow: LoadedWorkflow | null): CodexRuntimeConfig {
    const codex = loadedWorkflow?.config.codex;
    return {
      command: codex?.command ?? "codex app-server",
      approvalPolicy: codex?.approvalPolicy,
      threadSandbox: codex?.threadSandbox,
      turnSandboxPolicy: codex?.turnSandboxPolicy,
      turnTimeoutMs: codex?.turnTimeoutMs ?? 3_600_000,
      readTimeoutMs: codex?.readTimeoutMs ?? 5_000,
      stallTimeoutMs: codex?.stallTimeoutMs ?? 300_000,
      maxTurns: loadedWorkflow?.config.agent.maxTurns ?? 20
    };
  }

  private async runHook(
    loadedWorkflow: LoadedWorkflow | null,
    hook: "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove",
    workspacePath: string
  ): Promise<void> {
    const command = loadedWorkflow?.config.hooks[hook];
    if (!command) return;
    await execAsync(command, {
      cwd: workspacePath,
      timeout: loadedWorkflow.config.hooks.timeoutMs ?? 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        SYMPHONY_WORKSPACE: workspacePath,
        SYMPHONY_WORKFLOW: loadedWorkflow.path
      }
    });
  }

  private async loadWorkflowTemplate(): Promise<string> {
    if (!this.options.workflowPath) {
      return [
        "# Symphony Task",
        "",
        "Identifier: {{identifier}}",
        "Title: {{title}}",
        "",
        "{{description}}",
        "",
        "Work inside this isolated workspace. Preserve unrelated changes. Report verification clearly."
      ].join("\n");
    }
    const raw = await readFile(this.options.workflowPath, "utf8");
    if (!raw.startsWith("---")) {
      return raw.trim();
    }
    const end = raw.indexOf("\n---", 3);
    if (end === -1) {
      return raw.trim();
    }
    return raw.slice(end + 4).trim();
  }
}

export function safeChildPath(root: string, childName: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, childName || randomUUID());
  const relative = path.relative(resolvedRoot, resolvedChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing workspace path outside root: ${resolvedChild}`);
  }
  return resolvedChild;
}

function slugify(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "item";
}
