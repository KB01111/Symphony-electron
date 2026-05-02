import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("workspace runtime uses defaults when no workflow is configured", async () => {
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

  expect(workspace.runtime.command).toBe("codex app-server");
  expect(workspace.runtime.turnTimeoutMs).toBe(3_600_000);
  expect(workspace.runtime.readTimeoutMs).toBe(5_000);
  expect(workspace.runtime.stallTimeoutMs).toBe(300_000);
  expect(workspace.runtime.maxTurns).toBe(20);
  expect(workspace.runtime.approvalPolicy).toBeUndefined();
  expect(workspace.runtime.threadSandbox).toBeUndefined();
});

test("workspace runtime reads codex config from workflow frontmatter", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    [
      "---",
      "codex:",
      "  command: my-codex app-server",
      "  approval_policy: never",
      "  thread_sandbox: read-only",
      "  turn_timeout_ms: 7200000",
      "  read_timeout_ms: 10000",
      "  stall_timeout_ms: 600000",
      "agent:",
      "  max_turns: 30",
      "---",
      "Handle {{ issue.identifier }}"
    ].join("\n"),
    "utf8"
  );
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
  const manager = new WorkspaceManager({ workflowPath });

  const workspace = await manager.prepareWorkspace(profile, task());

  expect(workspace.runtime.command).toBe("my-codex app-server");
  expect(workspace.runtime.approvalPolicy).toBe("never");
  expect(workspace.runtime.threadSandbox).toBe("read-only");
  expect(workspace.runtime.turnTimeoutMs).toBe(7_200_000);
  expect(workspace.runtime.readTimeoutMs).toBe(10_000);
  expect(workspace.runtime.stallTimeoutMs).toBe(600_000);
  expect(workspace.runtime.maxTurns).toBe(30);
});

test("afterRun with no workflow does not throw", async () => {
  const root = await tempRoot();
  const workspacePath = path.join(root, "ws");
  await mkdir(workspacePath, { recursive: true });
  const manager = new WorkspaceManager();

  await expect(manager.afterRun(workspacePath)).resolves.toBeUndefined();
});

test("beforeRemove with no workflow does not throw", async () => {
  const root = await tempRoot();
  const workspacePath = path.join(root, "ws");
  await mkdir(workspacePath, { recursive: true });
  const manager = new WorkspaceManager();

  await expect(manager.beforeRemove(workspacePath)).resolves.toBeUndefined();
});

test("executes workflow hooks in workspace lifecycle order", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  const hookPath = path.join(root, "hook.js");

  await writeFile(
    hookPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.appendFileSync(path.join(process.cwd(), 'hook-log.txt'), `${process.argv[2]}\\n`);"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    workflowPath,
    [
      "---",
      "hooks:",
      `  after_create: node ${JSON.stringify(hookPath)} after-create`,
      `  before_run: node ${JSON.stringify(hookPath)} before-run`,
      `  after_run: node ${JSON.stringify(hookPath)} after-run`,
      `  before_remove: node ${JSON.stringify(hookPath)} before-remove`,
      "  timeout_ms: 5000",
      "---",
      "Handle {{ issue.identifier }}"
    ].join("\n"),
    "utf8"
  );
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
  const manager = new WorkspaceManager({ workflowPath });

  const workspace = await manager.prepareWorkspace(profile, task());
  await manager.afterRun(workspace.path);
  await manager.beforeRemove(workspace.path);

  await expect(readFile(path.join(workspace.path, "hook-log.txt"), "utf8")).resolves.toBe(
    ["after-create", "before-run", "after-run", "before-remove", ""].join("\n")
  );
});

