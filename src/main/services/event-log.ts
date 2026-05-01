import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent } from "../../shared/types.js";
import { isoNow } from "./time.js";

export type RunEventInput = Omit<Partial<RunEvent>, "id" | "runId" | "timestamp"> & Pick<RunEvent, "type">;

export class JsonlEventLog {
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(private readonly root: string) {}

  async append(runId: string, input: RunEventInput): Promise<RunEvent> {
    const event: RunEvent = {
      id: randomUUID(),
      runId,
      timestamp: isoNow(),
      ...input
    };
    const filePath = this.filePath(runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  onAppend(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async replay(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readFile(this.filePath(runId), "utf8");
      return raw
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  exportPath(runId: string): string {
    return this.filePath(runId);
  }

  private filePath(runId: string): string {
    return path.join(this.root, "runs", `${runId}.jsonl`);
  }
}

