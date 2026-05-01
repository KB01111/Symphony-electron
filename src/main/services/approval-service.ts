import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalStatus } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

export type ApprovalInput = Pick<ApprovalRequest, "runId" | "kind" | "title" | "detail" | "payload"> & {
  protocolRequestId?: string | number;
};

export class ApprovalService {
  private readonly store: FileStateStore<ApprovalRequest[]>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<ApprovalRequest[]>(path.join(appDataRoot, "state", "approvals.json"), []);
  }

  async create(input: ApprovalInput): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: `approval-${randomUUID().slice(0, 12)}`,
      createdAt: isoNow(),
      status: "pending",
      ...input
    };
    const approvals = await this.store.read();
    approvals.push(approval);
    await this.store.write(approvals);
    return approval;
  }

  async list(): Promise<ApprovalRequest[]> {
    return this.store.read();
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return (await this.list()).filter((approval) => approval.status === "pending");
  }

  async listForRun(runId: string): Promise<ApprovalRequest[]> {
    return (await this.list()).filter((approval) => approval.runId === runId);
  }

  async resolve(approvalId: string, approved: boolean): Promise<ApprovalRequest> {
    return this.patch(approvalId, approved ? "approved" : "denied");
  }

  private async patch(approvalId: string, status: ApprovalStatus): Promise<ApprovalRequest> {
    const approvals = await this.store.read();
    const index = approvals.findIndex((approval) => approval.id === approvalId);
    if (index < 0) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    const current = approvals[index];
    if (!current) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    const updated: ApprovalRequest = {
      ...current,
      status,
      resolvedAt: isoNow()
    };
    approvals[index] = updated;
    await this.store.write(approvals);
    return updated;
  }
}
