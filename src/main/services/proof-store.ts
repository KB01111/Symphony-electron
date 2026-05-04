import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProofEntry, ProofInput } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

export class ProofStore {
  private readonly store: FileStateStore<ProofEntry[]>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    appDataRoot: string,
    private readonly now: () => string = () => isoNow()
  ) {
    this.store = new FileStateStore<ProofEntry[]>(path.join(appDataRoot, "state", "proof.json"), []);
  }

  async list(runId: string): Promise<ProofEntry[]> {
    return (await this.store.read()).filter((entry) => entry.runId === runId);
  }

  async listAll(): Promise<ProofEntry[]> {
    return this.store.read();
  }

  async add(runId: string, input: ProofInput): Promise<ProofEntry> {
    const existing = input.source ? (await this.store.read()).find((entry) => entry.runId === runId && entry.source === input.source && entry.kind === input.kind) : undefined;
    if (existing) {
      return this.patch(existing.id, input);
    }
    const createdAt = this.now();
    const entry: ProofEntry = {
      id: `proof-${createdAt.replace(/[-:TZ.]/g, "").slice(0, 17)}-${randomUUID().slice(0, 12)}`,
      runId,
      createdAt,
      ...input
    };
    await this.serializeWrite(async () => {
      const entries = await this.store.read();
      entries.push(entry);
      await this.store.write(entries);
    });
    return entry;
  }

  async summary(runId: string): Promise<string> {
    const entries = await this.list(runId);
    if (!entries.length) return "No proof entries were recorded.";
    return entries.map((entry) => `[${entry.status}] ${entry.label}: ${entry.detail}`).join("\n");
  }

  private async patch(entryId: string, input: ProofInput): Promise<ProofEntry> {
    return this.serializeWrite(async () => {
      const entries = await this.store.read();
      const index = entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) {
        throw new Error(`Unknown proof entry: ${entryId}`);
      }
      const updated: ProofEntry = {
        ...entries[index]!,
        ...input,
        updatedAt: this.now()
      };
      entries[index] = updated;
      await this.store.write(entries);
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
