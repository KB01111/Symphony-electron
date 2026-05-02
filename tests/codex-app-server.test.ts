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
