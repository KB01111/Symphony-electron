import type { AutomationPolicy, OrchestratorSnapshot, OrchestratorState, Run, Task } from "../../shared/types.js";
import type { RunEventInput } from "./event-log.js";

type OrchestratorDependencies = {
  readState(): Promise<OrchestratorState>;
  writeState(state: OrchestratorState): Promise<void>;
  listCandidateTasks(): Promise<Task[]>;
  listRuns(): Promise<Run[]>;
  startRun(task: Task): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<unknown>;
  now?: () => Date;
};

const ACTIVE_RUN_STATES = new Set<Run["state"]>(["preparing", "running", "stalled"]);
const RECOVERY_POLL_INTERVAL_SECONDS = 30;

export class OrchestratorService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => Date;
  private mutationQueue: Promise<void> = Promise.resolve();
  private pauseRequested = false;

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async start(): Promise<OrchestratorState> {
    return this.enqueueMutation(async () => {
      const current = await this.dependencies.readState();
      const next: OrchestratorState = { ...current, mode: "autonomous", paused: false };
      this.pauseRequested = false;
      await this.dependencies.writeState(next);
      this.schedule(next.policy.pollIntervalSeconds);
      return next;
    });
  }

  async pause(): Promise<OrchestratorState> {
    this.pauseRequested = true;
    this.clearTimer();
    return this.enqueueMutation(async () => {
      const current = await this.dependencies.readState();
      const next: OrchestratorState = { ...current, paused: true };
      await this.dependencies.writeState(next);
      return next;
    });
  }

  resume(): Promise<OrchestratorState> {
    return this.start();
  }

  async updatePolicy(policy: Partial<AutomationPolicy>): Promise<OrchestratorState> {
    return this.enqueueMutation(async () => {
      const current = await this.dependencies.readState();
      const next: OrchestratorState = { ...current, policy: { ...current.policy, ...policy } };
      await this.dependencies.writeState(next);
      return next;
    });
  }

  async snapshot(): Promise<OrchestratorSnapshot> {
    const state = await this.dependencies.readState();
    return {
      state,
      queuedTaskIds: [],
      activeRuns: state.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId }))
    };
  }

  async tick(): Promise<OrchestratorSnapshot> {
    return this.enqueueMutation(() => this.runTick());
  }

  stop(): void {
    this.pauseRequested = true;
    this.clearTimer();
  }

  private async runTick(): Promise<OrchestratorSnapshot> {
    const [state, candidates, runs] = await Promise.all([
      this.dependencies.readState(),
      this.dependencies.listCandidateTasks(),
      this.dependencies.listRuns()
    ]);
    const now = this.now();
    const nowIso = now.toISOString();
    const activeRuns = runs.filter((run) => ACTIVE_RUN_STATES.has(run.state));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const launchedTaskIds = new Set(runs.map((run) => run.taskId));
    const activeTaskIds = new Set(activeRuns.map((run) => run.taskId));
    const activeClaims = state.activeClaims.filter((claim) => {
      const run = runsById.get(claim.runId);
      return run ? ACTIVE_RUN_STATES.has(run.state) : false;
    });
    const claimedTaskIds = new Set(activeClaims.map((claim) => claim.taskId));
    let activeCount = new Set([...activeTaskIds, ...claimedTaskIds]).size;
    const queuedTaskIds: string[] = [];
    const retryQueueByTaskId = new Map(state.retryQueue.map((entry) => [entry.taskId, entry]));
    const next: OrchestratorState = {
      ...state,
      activeClaims,
      retryQueue: [...retryQueueByTaskId.values()],
      lastTickAt: nowIso
    };

    for (const candidate of candidates) {
      if (claimedTaskIds.has(candidate.id) || launchedTaskIds.has(candidate.id)) {
        continue;
      }

      if (next.paused || !next.policy.autoStart) {
        queuedTaskIds.push(candidate.id);
        continue;
      }

      const retry = retryQueueByTaskId.get(candidate.id);
      if (retry && new Date(retry.nextAttemptAt).getTime() > now.getTime()) {
        queuedTaskIds.push(candidate.id);
        continue;
      }

      if (activeCount >= next.policy.maxConcurrentRuns) {
        queuedTaskIds.push(candidate.id);
        continue;
      }

      let run: Run;
      try {
        run = await this.dependencies.startRun(candidate);
      } catch (error) {
        const attempts = (retryQueueByTaskId.get(candidate.id)?.attempts ?? 0) + 1;
        const backoffSeconds = Math.min(10 * 2 ** (attempts - 1), next.policy.maxRetryBackoffSeconds);
        retryQueueByTaskId.set(candidate.id, {
          taskId: candidate.id,
          attempts,
          nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000).toISOString(),
          lastError: (error as Error).message
        });
        next.retryQueue = [...retryQueueByTaskId.values()];
        continue;
      }

      next.activeClaims.push({
        taskId: candidate.id,
        runId: run.id,
        identifier: candidate.identifier,
        startedAt: run.startedAt ?? nowIso
      });
      claimedTaskIds.add(candidate.id);
      activeTaskIds.add(candidate.id);
      activeCount += 1;
      retryQueueByTaskId.delete(candidate.id);
      next.retryQueue = [...retryQueueByTaskId.values()];

      try {
        await this.dependencies.appendEvent(run.id, {
          type: "orchestrator.claimed",
          message: `Autonomous orchestrator claimed ${candidate.identifier}.`
        });
      } catch {
        // Event logging must not requeue work after the run has already started.
      }
    }

    await this.dependencies.writeState(next);
    return {
      state: next,
      queuedTaskIds,
      activeRuns: next.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId }))
    };
  }

  private schedule(intervalSeconds: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .then((snapshot) => {
          if (!this.pauseRequested && !snapshot.state.paused && snapshot.state.policy.autoStart) {
            this.schedule(snapshot.state.policy.pollIntervalSeconds);
          }
        })
        .catch((error) => void this.recordTickFailure(error));
    }, Math.max(1, intervalSeconds) * 1000);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async recordTickFailure(error: unknown): Promise<void> {
    let current: OrchestratorState | undefined;
    try {
      current = await this.enqueueMutation(async () => {
        const currentState = await this.dependencies.readState();
        await this.dependencies.writeState({ ...currentState, lastError: (error as Error).message });
        return currentState;
      });
    } catch {
      current = undefined;
    }
    if (this.pauseRequested) {
      return;
    }
    if (current) {
      if (!current.paused && current.policy.autoStart) {
        this.schedule(current.policy.pollIntervalSeconds);
      }
    } else {
      this.schedule(RECOVERY_POLL_INTERVAL_SECONDS);
    }
  }
}
