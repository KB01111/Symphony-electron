import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApprovalKind, ApprovalRequest } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

export interface CreateApprovalInput {
  runId: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  payload: unknown;
}

export class ApprovalStore {
  private readonly store: FileStateStore<ApprovalRequest[]>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<ApprovalRequest[]>(path.join(appDataRoot, "state", "approvals.json"), []);
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `approval-${randomUUID().slice(0, 12)}`,
      ...input,
      createdAt: isoNow()
    };
    const approvals = await this.store.read();
    approvals.push(request);
    await this.store.write(approvals);
    return request;
  }

  async list(runId?: string): Promise<ApprovalRequest[]> {
    const approvals = await this.store.read();
    return runId ? approvals.filter((request) => request.runId === runId) : approvals;
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return (await this.list()).filter((request) => request.approved === undefined);
  }

  async respond(requestId: string, approved: boolean): Promise<ApprovalRequest> {
    const approvals = await this.store.read();
    const index = approvals.findIndex((request) => request.id === requestId);
    if (index < 0) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }
    const request = approvals[index];
    if (!request) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }
    const updated: ApprovalRequest = {
      ...request,
      approved,
      respondedAt: isoNow()
    };
    approvals[index] = updated;
    await this.store.write(approvals);
    return updated;
  }
}
