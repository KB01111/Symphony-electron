import { expect, test } from "vitest";
import { githubConfigForTask, latestRunWithWorkspace } from "../src/main/app-controller.js";
import type { Run, Task } from "../src/shared/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "linear:lin-1",
    source: "linear",
    externalId: "lin-1",
    identifier: "ENG-1",
    title: "Task",
    description: "",
    status: "Ready",
    priority: 0,
    updatedAt: "2026-05-02T10:00:00.000Z",
    ...overrides
  };
}

function run(overrides: Partial<Run>): Run {
  return {
    id: "run-1",
    taskId: "linear:lin-1",
    profileId: "profile-1",
    state: "running",
    updatedAt: "2026-05-02T10:00:00.000Z",
    startedAt: "2026-05-02T10:00:00.000Z",
    ...overrides
  };
}

test("githubConfigForTask tolerates missing descriptions", () => {
  expect(githubConfigForTask(task({ description: undefined as unknown as string }))).toBeUndefined();
});

test("githubConfigForTask infers repository URLs from descriptions", () => {
  expect(githubConfigForTask(task({ description: "See https://github.com/acme/widgets/pull/42" }))).toMatchObject({
    owner: "acme",
    repo: "widgets"
  });
});

test("latestRunWithWorkspace ignores failed retry workspaces and picks the newest active run", () => {
  const selected = latestRunWithWorkspace(
    [
      run({ id: "old-failed", state: "failed", workspacePath: "/work/old", updatedAt: "2026-05-02T10:05:00.000Z" }),
      run({ id: "active-old", state: "running", workspacePath: "/work/active-old", updatedAt: "2026-05-02T10:01:00.000Z" }),
      run({ id: "active-new", state: "review", workspacePath: "/work/active-new", updatedAt: "2026-05-02T10:03:00.000Z" })
    ],
    "linear:lin-1"
  );

  expect(selected?.id).toBe("active-new");
});
