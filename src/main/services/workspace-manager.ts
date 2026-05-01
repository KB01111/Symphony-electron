import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Profile, Task, WorkspaceRef } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

export class WorkspaceManager {
  constructor(private readonly options: { workflowPath?: string } = {}) {}

  async prepareWorkspace(profile: Profile, task: Task): Promise<WorkspaceRef> {
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

    const workflowPrompt = await this.renderWorkflowPrompt(task);
    const promptPath = path.join(workspacePath, "SYMPHONY_TASK.md");
    await writeFile(promptPath, workflowPrompt, "utf8");

    return {
      path: workspacePath,
      promptPath,
      workflowPrompt,
      ...(repoCachePath ? { repoCachePath } : {})
    };
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

  private async renderWorkflowPrompt(task: Task): Promise<string> {
    const template = await this.loadWorkflowTemplate();
    return template
      .replaceAll("{{identifier}}", task.identifier)
      .replaceAll("{{title}}", task.title)
      .replaceAll("{{description}}", task.description)
      .replaceAll("{{url}}", task.url ?? "")
      .replaceAll("{{task_id}}", task.id);
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
