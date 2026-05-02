import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApprovalKind, ApprovalRequest } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

export interface CreateApprovalInput {
  runId: string;
  protocolRequestId?: string | number;
  protocolMethod?: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  payload: unknown;
}

export class ApprovalStore {
  private readonly store: FileStateStore<ApprovalRequest[]>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<ApprovalRequest[]>(path.join(appDataRoot, "state", "approvals.json"), []);
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `approval-${randomUUID().slice(0, 12)}`,
      ...input,
      createdAt: isoNow()
    };
    await this.serializeWrite(async () => {
      const approvals = await this.store.read();
      approvals.push(request);
      await this.store.write(approvals);
    });
    return request;
  }

  async list(runId?: string): Promise<ApprovalRequest[]> {
    const approvals = await this.store.read();
    return runId ? approvals.filter((request) => request.runId === runId) : approvals;
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return (await this.list()).filter((request) => request.approved === undefined);
  }

  async get(requestId: string): Promise<ApprovalRequest> {
    const request = (await this.store.read()).find((candidate) => candidate.id === requestId);
    if (!request) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }
    return request;
  }

  async respond(requestId: string, approved: boolean): Promise<ApprovalRequest> {
    return this.serializeWrite(async () => {
      const approvals = await this.store.read();
      const index = approvals.findIndex((request) => request.id === requestId);
      if (index < 0) {
        throw new Error(`Unknown approval request: ${requestId}`);
      }
      const request = approvals[index] as ApprovalRequest;
      if (request.approved !== undefined) {
        throw new Error(`Approval request already responded: ${requestId}`);
      }
      const updated: ApprovalRequest = {
        ...request,
        approved,
        respondedAt: isoNow()
      };
      approvals[index] = updated;
      await this.store.write(approvals);
      return updated;
    });
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
