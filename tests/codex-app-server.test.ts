import { expect, test } from "vitest";
import { buildThreadStartParams } from "../src/main/services/codex-app-server.js";

test("builds thread params from workflow Codex runtime config", () => {
  const params = buildThreadStartParams({
    cwd: "C:\\workspaces\\ENG-42",
    prompt: "Handle ENG-42",
    approvalPolicy: "on-failure",
    sandbox: "read-only",
    baseInstructions: "Use Symphony policy",
    dynamicTools: []
  });

  expect(params).toMatchObject({
    cwd: "C:\\workspaces\\ENG-42",
    approvalPolicy: "on-failure",
    sandbox: "read-only",
    baseInstructions: "Use Symphony policy",
    serviceName: "symphony-electron",
    dynamicTools: []
  });
});

test("applies fixed fields regardless of input", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work" });

  expect(params.approvalsReviewer).toBe("auto_review");
  expect(params.serviceName).toBe("symphony-electron");
  expect(params.experimentalRawEvents).toBe(false);
  expect(params.persistExtendedHistory).toBe(true);
});

test("defaults approval policy to on-request when not provided", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work" });
  expect(params.approvalPolicy).toBe("on-request");
});

test("defaults approval policy to on-request for unrecognized value", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work", approvalPolicy: "banana" });
  expect(params.approvalPolicy).toBe("on-request");
});

test("passes through all recognized approval policy string values", () => {
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", approvalPolicy: "never" }).approvalPolicy).toBe("never");
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", approvalPolicy: "untrusted" }).approvalPolicy).toBe("untrusted");
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", approvalPolicy: "on-request" }).approvalPolicy).toBe("on-request");
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", approvalPolicy: "on-failure" }).approvalPolicy).toBe("on-failure");
});

test("passes through granular approval policy object", () => {
  const granular = { granular: { readFile: "never", writeFile: "on-request" } };
  const params = buildThreadStartParams({ cwd: "/ws", prompt: "x", approvalPolicy: granular });
  expect(params.approvalPolicy).toEqual(granular);
});

test("defaults sandbox to workspace-write when not provided", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work" });
  expect(params.sandbox).toBe("workspace-write");
});

test("defaults sandbox to workspace-write for unrecognized value", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work", sandbox: "super-safe" });
  expect(params.sandbox).toBe("workspace-write");
});

test("passes through all valid sandbox mode values", () => {
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", sandbox: "read-only" }).sandbox).toBe("read-only");
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", sandbox: "workspace-write" }).sandbox).toBe("workspace-write");
  expect(buildThreadStartParams({ cwd: "/ws", prompt: "x", sandbox: "danger-full-access" }).sandbox).toBe("danger-full-access");
});

test("uses default base instructions when not provided", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work" });
  expect(params.baseInstructions).toContain("Symphony Electron");
});

test("uses default dynamic tools when not provided", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work" });
  expect(Array.isArray(params.dynamicTools)).toBe(true);
  expect((params.dynamicTools ?? []).length).toBeGreaterThan(0);
  expect((params.dynamicTools ?? [])[0]).toMatchObject({ namespace: "linear", name: "linear_graphql" });
});

test("null sandbox defaults to workspace-write", () => {
  const params = buildThreadStartParams({ cwd: "/tmp/ws", prompt: "do work", sandbox: null });
  expect(params.sandbox).toBe("workspace-write");
});
