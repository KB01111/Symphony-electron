import path from "node:path";
import type { Task } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";

export class TaskService {
  private readonly store: FileStateStore<Task[]>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<Task[]>(path.join(appDataRoot, "state", "tasks.json"), []);
  }

  async list(): Promise<Task[]> {
    return this.store.read();
  }

  async upsert(task: Task): Promise<Task> {
    const tasks = await this.store.read();
    const existingIndex = tasks.findIndex((candidate) => candidate.id === task.id);
    if (existingIndex >= 0) {
      tasks[existingIndex] = task;
    } else {
      tasks.push(task);
    }
    await this.store.write(tasks);
    return task;
  }

  async upsertMany(incoming: Task[]): Promise<Task[]> {
    const tasks = await this.store.read();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of incoming) {
      byId.set(task.id, task);
    }
    const merged = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await this.store.write(merged);
    return merged;
  }

  async get(taskId: string): Promise<Task> {
    const task = (await this.list()).find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  async archive(taskId: string): Promise<void> {
    const tasks = await this.store.read();
    await this.store.write(tasks.filter((task) => task.id !== taskId));
  }
}

