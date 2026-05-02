import { expect, test } from "vitest";
import { isApprovalRequestMethod } from "../src/main/services/run-service.js";

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
