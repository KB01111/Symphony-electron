import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WorkflowService } from "../src/main/services/workflow-service.js";
import type { Task } from "../src/shared/types.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-workflow-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function task(): Task {
  return {
    id: "linear:issue-1",
    source: "linear",
    externalId: "issue-1",
    identifier: "ENG-42",
    title: "Finish cockpit",
    description: "Make the UI useful",
    status: "Ready",
    priority: 2,
    labels: ["ui", "orchestration"],
    blockers: [],
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
}

test("loads front matter defaults and renders strict Liquid issue prompts", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    [
      "---",
      "tracker:",
      "  kind: linear",
      "  api_key: $LINEAR_API_KEY",
      "  project_slug: symphony",
      "polling:",
      "  interval_ms: 45000",
      "agent:",
      "  max_concurrent_agents: 3",
      "---",
      "Handle {{ issue.identifier }}: {{ issue.title }}",
      "Labels: {{ issue.labels | join: ', ' }}",
      "Attempt: {{ attempt | default: 'first' }}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkflowService(workflowPath, { LINEAR_API_KEY: "lin_test" });
  const loaded = await service.load();
  const rendered = await service.renderPrompt(task());

  expect(loaded.validation.ok).toBe(true);
  expect(loaded.config.tracker.projectSlug).toBe("symphony");
  expect(loaded.config.polling.intervalMs).toBe(45_000);
  expect(loaded.config.agent.maxConcurrentAgents).toBe(3);
  expect(rendered).toContain("Handle ENG-42: Finish cockpit");
  expect(rendered).toContain("Labels: ui, orchestration");
  expect(rendered).toContain("Attempt: first");
});

test("keeps the last good workflow when a reload is invalid", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(workflowPath, "---\ntracker:\n  kind: linear\n  project_slug: symphony\n---\nShip {{ issue.identifier }}", "utf8");
  const service = new WorkflowService(workflowPath, { LINEAR_API_KEY: "lin_test" });

  await expect(service.renderPrompt(task())).resolves.toBe("Ship ENG-42");

  await writeFile(workflowPath, "---\ntracker: [not-a-map]\n---\nBroken {{ missing.value }}", "utf8");

  const loaded = await service.load();
  await expect(service.renderPrompt(task())).resolves.toBe("Ship ENG-42");
  expect(loaded.validation.ok).toBe(false);
  expect(loaded.validation.errors[0]).toContain("tracker");
});

test("fails rendering on unknown variables", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(workflowPath, "Ship {{ issue.identifier }} using {{ missing.value }}", "utf8");
  const service = new WorkflowService(workflowPath, {});

  await expect(service.renderPrompt(task())).rejects.toThrow(/missing/);
});

test("normalizes upstream-style GitHub, writeback, proof, and trust config", async () => {
  const root = await tempRoot();
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    [
      "---",
      "github:",
      "  repository_url: https://github.com/acme/widgets",
      "  default_branch: trunk",
      "writeback:",
      "  auto_create_pr: true",
      "  auto_update_pr: true",
      "  human_review_state: Review",
      "proof:",
      "  require_ci: true",
      "trust:",
      "  trusted_environment: true",
      "  allowed_repositories:",
      "    - https://github.com/acme/widgets",
      "codex:",
      "  turn_sandbox_policy:",
      "    type: readOnly",
      "    networkAccess: false",
      "---",
      "Ship {{ issue.identifier }}"
    ].join("\n"),
    "utf8"
  );

  const loaded = await new WorkflowService(workflowPath, {}).load();

  expect(loaded.config.github).toMatchObject({ repositoryUrl: "https://github.com/acme/widgets", defaultBranch: "trunk" });
  expect(loaded.config.writeback).toMatchObject({ autoCreatePr: true, autoUpdatePr: true, humanReviewStateName: "Review" });
  expect(loaded.config.proof.requireCi).toBe(true);
  expect(loaded.config.trust.trustedEnvironment).toBe(true);
  expect(loaded.config.trust.allowedRepositories).toEqual(["https://github.com/acme/widgets"]);
  expect(loaded.config.codex.turnSandboxPolicy).toMatchObject({ type: "readOnly", networkAccess: false });
});
