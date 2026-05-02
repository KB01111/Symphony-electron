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

  async add(runId: string, input: ProofInput): Promise<ProofEntry> {
    const entry: ProofEntry = {
      id: `proof-${randomUUID().slice(0, 12)}`,
      runId,
      createdAt: this.now(),
      ...input
    };
    await this.serializeWrite(async () => {
      const entries = await this.store.read();
      entries.push(entry);
      await this.store.write(entries);
    });
    return entry;
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
