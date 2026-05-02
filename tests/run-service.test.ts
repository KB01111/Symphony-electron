import { expect, test } from "vitest";
import { approvalResponseFor, isApprovalRequestMethod } from "../src/main/services/run-service.js";
import type { ApprovalRequest } from "../src/shared/types.js";

test("approval detector only accepts explicit request approval method names", () => {
  expect(isApprovalRequestMethod("item/commandExecution/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("item/fileChange/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("item/permissions/requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("tool/request_approval")).toBe(true);
  expect(isApprovalRequestMethod("requestApproval")).toBe(true);
  expect(isApprovalRequestMethod("applyPatchApproval")).toBe(true);
  expect(isApprovalRequestMethod("execCommandApproval")).toBe(true);

  expect(isApprovalRequestMethod("outputDelta")).toBe(false);
  expect(isApprovalRequestMethod("patchUpdated")).toBe(false);
  expect(isApprovalRequestMethod("item/commandExecution/started")).toBe(false);
  expect(isApprovalRequestMethod("approvalStatusUpdated")).toBe(false);
});

test("approval responses support singular permission method names", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    runId: "run-1",
    protocolRequestId: "request-1",
    protocolMethod: "requestPermission",
    kind: "network",
    title: "Approve network access",
    detail: "network",
    status: "pending",
    createdAt: "2026-05-02T10:00:00.000Z",
    payload: {
      id: "request-1",
      method: "requestPermission",
      params: {
        permissions: {
          network: true
        }
      }
    }
  };

  expect(approvalResponseFor(approval, true)).toEqual({
    permissions: {
      network: true
    },
    scope: "turn",
    strictAutoReview: true
  });
});
