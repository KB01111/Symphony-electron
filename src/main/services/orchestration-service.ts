import type { HealthCheckResult, LinearConfig, Profile, Run, RunReference, SchedulerSnapshot, Task } from "../../shared/types.js";

interface OrchestrationOptions {
  getLinearConfig(): Promise<LinearConfig>;
  syncLinear(): Promise<Task[]>;
  listProfiles(): Promise<Profile[]>;
  checkProfileHealth(profile: Profile): Promise<HealthCheckResult>;
  listRuns(): Promise<Run[]>;
  startRun(task: Task, profile: Profile): Promise<Run>;
  now?: () => Date;
  onSnapshot?(snapshot: SchedulerSnapshot): void;
}

export class OrchestrationService {
  private enabled = false;
  private timer: NodeJS.Timeout | null = null;
  private snapshotState: SchedulerSnapshot = {
    enabled: false,
    running: [],
    queuedTaskIds: [],
    retryQueue: []
  };
  private readonly retryQueue = new Map<string, { taskId: string; attempts: number; nextAttemptAt: string; lastError: string }>();
  private readonly listeners = new Set<(snapshot: SchedulerSnapshot) => void>();
  private readonly now: () => Date;
  private pollIntervalSeconds = 60;

  constructor(private readonly options: OrchestrationOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<SchedulerSnapshot> {
    if (!this.enabled) {
      this.enabled = true;
      await this.tick();
    }
    return this.scheduleNext();
  }

  stop(): SchedulerSnapshot {
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const { nextPollAt: _nextPollAt, ...rest } = this.snapshotState;
    this.publish({ ...rest, enabled: false });
    return this.snapshotState;
  }

  async tick(): Promise<SchedulerSnapshot> {
    const at = this.now();
    try {
      const config = await this.options.getLinearConfig();
      this.pollIntervalSeconds = Math.max(15, Number(config.pollIntervalSeconds) || 60);
      const [tasks, profiles, runs] = await Promise.all([this.options.syncLinear(), this.options.listProfiles(), this.options.listRuns()]);
      const activeRuns = runs.filter((run) => run.state === "preparing" || run.state === "running" || run.state === "stalled");
      const runningTaskIds = new Set(activeRuns.map((run) => run.taskId));
      const terminalStateNames = new Set((config.terminalStateNames ?? ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]).map(normalize));
      const maxConcurrentRuns = Math.max(1, Number(config.maxConcurrentRuns) || 2);
      const startedRuns: RunReference[] = [];
      const queuedTaskIds: string[] = [];
      let slots = Math.max(maxConcurrentRuns - activeRuns.length, 0);

      const candidates = tasks
        .filter((task) => (config.activeStateNames ?? []).map(normalize).includes(normalize(task.status)))
        .sort(compareTasks);

      for (const task of candidates) {
        if (runningTaskIds.has(task.id)) continue;
        const retry = this.retryQueue.get(task.id);
        if (retry && new Date(retry.nextAttemptAt).getTime() > at.getTime()) {
          queuedTaskIds.push(task.id);
          continue;
        }
        if (!passesBlockerGate(task, terminalStateNames)) {
          queuedTaskIds.push(task.id);
          continue;
        }
        if (slots <= 0) {
          queuedTaskIds.push(task.id);
          continue;
        }
        const profile = await this.selectProfile(profiles);
        if (!profile) {
          queuedTaskIds.push(task.id);
          continue;
        }
        try {
          const run = await this.options.startRun(task, profile);
          startedRuns.push({ id: run.id, taskId: run.taskId });
          runningTaskIds.add(task.id);
          this.retryQueue.delete(task.id);
          slots -= 1;
        } catch (error) {
          const attempts = (retry?.attempts ?? 0) + 1;
          const delayMs = Math.min(10_000 * 2 ** (attempts - 1), 300_000);
          this.retryQueue.set(task.id, {
            taskId: task.id,
            attempts,
            nextAttemptAt: new Date(at.getTime() + delayMs).toISOString(),
            lastError: (error as Error).message
          });
          queuedTaskIds.push(task.id);
        }
      }

      this.publish({
        enabled: this.enabled,
        running: [...activeRuns.map((run) => ({ id: run.id, taskId: run.taskId, profileId: run.profileId })), ...startedRuns],
        queuedTaskIds,
        retryQueue: [...this.retryQueue.values()],
        lastPollAt: at.toISOString()
      });
    } catch (error) {
      this.publish({
        ...this.snapshotState,
        enabled: this.enabled,
        lastPollAt: at.toISOString(),
        lastError: (error as Error).message
      });
    }
    return this.enabled ? this.scheduleNext() : this.snapshotState;
  }

  snapshot(): SchedulerSnapshot {
    return this.snapshotState;
  }

  onSnapshot(listener: (snapshot: SchedulerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async selectProfile(profiles: Profile[]): Promise<Profile | null> {
    for (const profile of profiles) {
      const health = await this.options.checkProfileHealth(profile);
      if (health.ok) return profile;
    }
    return profiles[0] ?? null;
  }

  private scheduleNext(): SchedulerSnapshot {
    if (!this.enabled) return this.snapshotState;
    if (this.timer) clearTimeout(this.timer);
    const intervalSeconds = this.pollIntervalSeconds;
    const nextPollAt = new Date(this.now().getTime() + intervalSeconds * 1000).toISOString();
    this.publish({ ...this.snapshotState, enabled: true, nextPollAt });
    this.timer = setTimeout(() => {
      void this.tick();
    }, intervalSeconds * 1000);
    return this.snapshotState;
  }

  private publish(snapshot: SchedulerSnapshot): void {
    this.snapshotState = {
      ...snapshot,
      running: snapshot.running.map((run) => ({ ...run })),
      queuedTaskIds: [...snapshot.queuedTaskIds],
      retryQueue: snapshot.retryQueue.map((retry) => ({ ...retry }))
    };
    this.options.onSnapshot?.(this.snapshotState);
    for (const listener of this.listeners) {
      listener(this.snapshotState);
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function compareTasks(a: Task, b: Task): number {
  const priorityA = a.priority || Number.MAX_SAFE_INTEGER;
  const priorityB = b.priority || Number.MAX_SAFE_INTEGER;
  if (priorityA !== priorityB) return priorityA - priorityB;
  const createdA = a.createdAt ?? a.updatedAt;
  const createdB = b.createdAt ?? b.updatedAt;
  if (createdA !== createdB) return createdA.localeCompare(createdB);
  return a.identifier.localeCompare(b.identifier);
}

function passesBlockerGate(task: Task, terminalStateNames: Set<string>): boolean {
  if (normalize(task.status) !== "todo") return true;
  return (task.blockers ?? []).every((blocker) => blocker.state && terminalStateNames.has(normalize(blocker.state)));
}
