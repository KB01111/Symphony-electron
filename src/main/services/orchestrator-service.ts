import type { ActiveRunMetric, AutomationPolicy, OrchestratorSnapshot, OrchestratorState, QueueReason, QueuedTask, Run, Task } from "../../shared/types.js";
import type { RunEventInput } from "./event-log.js";

type OrchestratorDependencies = {
  readState(): Promise<OrchestratorState>;
  writeState(state: OrchestratorState): Promise<void>;
  listCandidateTasks(): Promise<Task[]>;
  getIssueState?(task: Task): Promise<{ status: string; updatedAt?: string } | undefined>;
  listRuns(): Promise<Run[]>;
  startRun(task: Task): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<unknown>;
  terminateRun?(runId: string): Promise<Run | void>;
  cleanWorkspace?(task: Task): Promise<void>;
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
      queue: [],
      activeRuns: state.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId })),
      activeMetrics: state.activeClaims.map((claim) => ({
        id: claim.runId,
        taskId: claim.taskId,
        identifier: claim.identifier,
        startedAt: claim.startedAt,
        ...(claim.lastEventAt ? { lastEventAt: claim.lastEventAt } : {})
      })),
      ...(!state.paused ? { nextPollAt: new Date(Date.now() + state.policy.pollIntervalSeconds * 1000).toISOString() } : {})
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
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const launchedTaskIds = new Set(runs.map((run) => run.taskId));
    const activeTaskIds = new Set(activeRuns.map((run) => run.taskId));
    const terminalStateNames = new Set(state.policy.terminalStateNames.map(normalize));
    const queue: QueuedTask[] = [];
    const retryQueueByTaskId = new Map(state.retryQueue.map((entry) => [entry.taskId, entry]));
    const activeClaims: OrchestratorState["activeClaims"] = [];
    const next: OrchestratorState = {
      ...state,
      activeClaims,
      retryQueue: [...retryQueueByTaskId.values()],
      lastTickAt: nowIso
    };
    const stateConcurrency = new Map<string, number>();
    const claimedRunIds = new Set<string>();

    for (const claim of state.activeClaims) {
      const run = runsById.get(claim.runId);
      if (!run) continue;
      const task = candidatesById.get(claim.taskId);
      if (!ACTIVE_RUN_STATES.has(run.state)) continue;
      const refreshedState = task && this.dependencies.getIssueState ? await this.dependencies.getIssueState(task).catch(() => undefined) : undefined;
      const effectiveStatus = refreshedState?.status ?? task?.status;
      if (task && effectiveStatus && terminalStateNames.has(normalize(effectiveStatus))) {
        await this.cancelClaim(claim.runId, "tracker_terminal", "Tracker moved to a terminal state.");
        await this.dependencies.cleanWorkspace?.(task);
        continue;
      }
      const lastActivity = new Date(claim.lastEventAt ?? run.updatedAt ?? claim.startedAt).getTime();
      const stalled = next.policy.stallTimeoutSeconds > 0 && now.getTime() - lastActivity > next.policy.stallTimeoutSeconds * 1000;
      if (stalled) {
        await this.cancelClaim(claim.runId, "orchestrator.stalled", "Run exceeded stall timeout.");
        const attempts = (retryQueueByTaskId.get(claim.taskId)?.attempts ?? 0) + 1;
        retryQueueByTaskId.set(claim.taskId, {
          taskId: claim.taskId,
          attempts,
          nextAttemptAt: nextRetryAt(now, attempts, next.policy.maxRetryBackoffSeconds),
          lastError: "stalled"
        });
        continue;
      }
      const lastEventAt = newerIso(claim.lastEventAt, run.updatedAt);
      const activeClaim = lastEventAt ? { ...claim, lastEventAt } : { ...claim };
      activeClaims.push(activeClaim);
      claimedRunIds.add(claim.runId);
      const stateKey = normalize(task?.status ?? run.state);
      stateConcurrency.set(stateKey, (stateConcurrency.get(stateKey) ?? 0) + 1);
    }

    for (const run of activeRuns) {
      if (!claimedRunIds.has(run.id)) {
        const stateKey = normalize(run.state);
        stateConcurrency.set(stateKey, (stateConcurrency.get(stateKey) ?? 0) + 1);
      }
    }
    next.retryQueue = [...retryQueueByTaskId.values()];
    const claimedTaskIds = new Set(activeClaims.map((claim) => claim.taskId));
    let activeCount = new Set([...activeTaskIds, ...claimedTaskIds]).size;

    for (const candidate of [...candidates].sort(compareCandidates)) {
      if (claimedTaskIds.has(candidate.id) || activeTaskIds.has(candidate.id) || launchedTaskIds.has(candidate.id)) {
        continue;
      }

      if (terminalStateNames.has(normalize(candidate.status))) {
        await this.dependencies.cleanWorkspace?.(candidate);
        continue;
      }

      if (!passesBlockerGate(candidate, terminalStateNames)) {
        queue.push(queueEntry(candidate, "blocked", "One or more blockers are not terminal."));
        continue;
      }

      if (next.paused || !next.policy.autoStart) {
        queue.push(queueEntry(candidate, next.paused ? "paused" : "policy_disabled", next.paused ? "Automation is paused." : "Auto-start is disabled."));
        continue;
      }

      const retry = retryQueueByTaskId.get(candidate.id);
      if (retry && new Date(retry.nextAttemptAt).getTime() > now.getTime()) {
        queue.push(queueEntry(candidate, "retry", retry.lastError, retry.nextAttemptAt));
        continue;
      }

      if (activeCount >= next.policy.maxConcurrentRuns) {
        queue.push(queueEntry(candidate, "concurrency", `Global concurrency limit ${next.policy.maxConcurrentRuns} reached.`));
        continue;
      }

      const stateKey = normalize(candidate.status);
      const stateLimit = next.policy.maxConcurrentRunsByState[stateKey];
      if (stateLimit !== undefined && (stateConcurrency.get(stateKey) ?? 0) >= stateLimit) {
        queue.push(queueEntry(candidate, "state_concurrency", `State concurrency limit ${stateLimit} reached for ${candidate.status}.`));
        continue;
      }

      let run: Run;
      try {
        run = await this.dependencies.startRun(candidate);
      } catch (error) {
        const attempts = (retryQueueByTaskId.get(candidate.id)?.attempts ?? 0) + 1;
        retryQueueByTaskId.set(candidate.id, {
          taskId: candidate.id,
          attempts,
          nextAttemptAt: nextRetryAt(now, attempts, next.policy.maxRetryBackoffSeconds),
          lastError: (error as Error).message
        });
        next.retryQueue = [...retryQueueByTaskId.values()];
        queue.push(queueEntry(candidate, "retry", (error as Error).message, retryQueueByTaskId.get(candidate.id)?.nextAttemptAt));
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
      stateConcurrency.set(stateKey, (stateConcurrency.get(stateKey) ?? 0) + 1);
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
      queuedTaskIds: queue.map((entry) => entry.taskId),
      queue,
      activeRuns: next.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId })),
      activeMetrics: buildActiveMetrics(next, runsById),
      ...(!next.paused ? { nextPollAt: new Date(now.getTime() + next.policy.pollIntervalSeconds * 1000).toISOString() } : {})
    };
  }

  private async cancelClaim(runId: string, type: string, message: string): Promise<void> {
    try {
      await this.dependencies.terminateRun?.(runId);
    } catch {
      // Swallow termination failures so reconciliation can continue.
    }

    try {
      await this.dependencies.appendEvent(runId, { type, message });
    } catch {
      // Reconciliation must continue even if the event log is temporarily unavailable.
    }
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

/**
 * Normalize a string by trimming surrounding whitespace and converting to lowercase.
 *
 * @param value - The input string to normalize
 * @returns The input string with leading/trailing whitespace removed and all characters lowercased
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Determines whether a task is eligible to proceed based on its blockers.
 *
 * For tasks whose normalized status is not `"todo"`, the task is considered eligible.
 * For `"todo"` tasks, every blocker must have a defined `state` and that state's normalized
 * value must be present in `terminalStateNames` for the task to be eligible.
 *
 * @param task - The task to evaluate for blocker gating
 * @param terminalStateNames - Set of normalized terminal state names used to consider blockers resolved
 * @returns `true` if the task may proceed (no unresolved blockers), `false` otherwise.
 */
function passesBlockerGate(task: Task, terminalStateNames: Set<string>): boolean {
  if (normalize(task.status) !== "todo") return true;
  return (task.blockers ?? []).every((blocker) => blocker.state && terminalStateNames.has(normalize(blocker.state)));
}

function queueEntry(task: Task, reason: QueueReason, detail?: string, nextAttemptAt?: string): QueuedTask {
  return {
    taskId: task.id,
    identifier: task.identifier,
    reason,
    ...(detail ? { detail } : {}),
    ...(nextAttemptAt ? { nextAttemptAt } : {})
  };
}

function compareCandidates(a: Task, b: Task): number {
  const priority = b.priority - a.priority;
  if (priority !== 0) return priority;
  return a.updatedAt.localeCompare(b.updatedAt);
}

function buildActiveMetrics(state: OrchestratorState, runsById: Map<string, Run>): ActiveRunMetric[] {
  return state.activeClaims.map((claim) => {
    const run = runsById.get(claim.runId);
    return {
      id: claim.runId,
      taskId: claim.taskId,
      identifier: claim.identifier,
      startedAt: claim.startedAt,
      ...(claim.lastEventAt ? { lastEventAt: claim.lastEventAt } : {}),
      ...(run?.turnCount !== undefined ? { turnCount: run.turnCount } : {}),
      ...(run?.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
      ...(run?.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
      ...(run?.totalTokens !== undefined ? { totalTokens: run.totalTokens } : {})
    };
  });
}

/**
 * Compute the next retry timestamp using exponential backoff capped by a maximum.
 *
 * @param now - Reference time from which the backoff is applied
 * @param attempts - Number of previous attempts (1-based); higher values increase the backoff
 * @param maxBackoffSeconds - Maximum backoff duration in seconds used to cap the exponential growth
 * @returns An ISO 8601 timestamp string for the next retry time
 */
function nextRetryAt(now: Date, attempts: number, maxBackoffSeconds: number): string {
  const backoffSeconds = Math.min(10 * 2 ** Math.max(attempts - 1, 0), maxBackoffSeconds);
  return new Date(now.getTime() + backoffSeconds * 1000).toISOString();
}

/**
 * Selects the later ISO timestamp between two timestamp strings.
 *
 * If one argument is missing, returns the other. When both are present, returns the chronologically later timestamp by lexicographic comparison. If both are missing, returns `undefined`.
 *
 * @param current - Existing ISO timestamp or `undefined`
 * @param candidate - New ISO timestamp to compare or `undefined`
 * @returns The later ISO timestamp string, or `undefined` if neither is provided
 */
function newerIso(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}
