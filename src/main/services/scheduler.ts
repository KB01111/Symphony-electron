import type { RunReference, Task } from "../../shared/types.js";

export interface RetryEntry {
  taskId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
}

interface SchedulerOptions {
  concurrency: number;
  runTask(task: Task): Promise<RunReference>;
  now?: () => Date;
  maxBackoffMs?: number;
}

export class Scheduler {
  private readonly activeRuns: RunReference[] = [];
  private readonly retryQueue = new Map<string, RetryEntry>();
  private queuedTaskIds: string[] = [];
  private readonly now: () => Date;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
  }

  async tick(tasks: Task[], at = this.now()): Promise<void> {
    const activeTaskIds = new Set(this.activeRuns.map((run) => run.taskId));
    const candidates = tasks.filter((task) => !activeTaskIds.has(task.id));
    this.queuedTaskIds = [];

    for (const task of candidates) {
      if (this.activeRuns.length >= this.options.concurrency) {
        this.queuedTaskIds.push(task.id);
        continue;
      }

      const retry = this.retryQueue.get(task.id);
      if (retry && new Date(retry.nextAttemptAt).getTime() > at.getTime()) {
        this.queuedTaskIds.push(task.id);
        continue;
      }

      try {
        const run = await this.options.runTask(task);
        this.activeRuns.push(run);
        this.retryQueue.delete(task.id);
      } catch (error) {
        const attempts = (retry?.attempts ?? 0) + 1;
        const backoffMs = Math.min(2 ** attempts * 1000, this.maxBackoffMs);
        this.retryQueue.set(task.id, {
          taskId: task.id,
          attempts,
          nextAttemptAt: new Date(at.getTime() + backoffMs).toISOString(),
          lastError: (error as Error).message
        });
      }
    }
  }

  snapshot(): { activeRuns: RunReference[]; queuedTaskIds: string[]; retryQueue: RetryEntry[] } {
    return {
      activeRuns: [...this.activeRuns],
      queuedTaskIds: [...this.queuedTaskIds],
      retryQueue: [...this.retryQueue.values()]
    };
  }
}

