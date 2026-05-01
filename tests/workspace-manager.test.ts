import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WorkspaceManager } from "../src/main/services/workspace-manager.js";
import type { Profile, Task } from "../src/shared/types.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-workspace-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function task(id = "lin-1"): Task {
  return {
    id,
    source: "linear",
    externalId: id,
    identifier: "ENG-42",
    title: "Implement orchestration",
    description: "Build it",
    status: "Ready",
    priority: 1,
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
}

test("creates deterministic workspaces inside the profile root", async () => {
  const root = await tempRoot();
  const profile: Profile = {
    id: "profile-1",
    name: "Default",
    codexHome: path.join(root, "codex-home"),
    workspaceRoot: path.join(root, "workspaces"),
    repoCacheRoot: path.join(root, "repos"),
    logsRoot: path.join(root, "logs"),
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
  const manager = new WorkspaceManager();

  const workspace = await manager.prepareWorkspace(profile, task());

  expect(workspace.path).toBe(path.join(profile.workspaceRoot, "ENG-42-lin-1"));
  expect(workspace.workflowPrompt).toContain("Implement orchestration");
});

test("loads WORKFLOW.md prompt body when present", async () => {
  const root = await tempRoot();
  const profile: Profile = {
    id: "profile-1",
    name: "Default",
    codexHome: path.join(root, "codex-home"),
    workspaceRoot: path.join(root, "workspaces"),
    repoCacheRoot: path.join(root, "repos"),
    logsRoot: path.join(root, "logs"),
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
  await writeFile(path.join(root, "WORKFLOW.md"), "---\nconcurrency: 2\n---\nHandle {{identifier}}: {{title}}");
  const manager = new WorkspaceManager({ workflowPath: path.join(root, "WORKFLOW.md") });

  const workspace = await manager.prepareWorkspace(profile, task());

  expect(workspace.workflowPrompt).toBe("Handle ENG-42: Implement orchestration");
});

