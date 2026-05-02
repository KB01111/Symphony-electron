import path from "node:path";
import type { AutomationPolicy, OrchestratorState } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";

export const defaultAutomationPolicy: AutomationPolicy = {
  autoStart: true,
  autoCreateHandoff: true,
  autoWriteTrackerUpdates: false,
  maxConcurrentRuns: 2,
  maxConcurrentRunsByState: {},
  pollIntervalSeconds: 60,
  stallTimeoutSeconds: 1800,
  maxRetryBackoffSeconds: 300,
  terminalStateNames: ["Done", "Canceled", "Cancelled", "Duplicate"],
  requireApprovalFor: ["merge"]
};

function cloneAutomationPolicy(policy: AutomationPolicy): AutomationPolicy {
  return {
    ...policy,
    terminalStateNames: [...policy.terminalStateNames],
    maxConcurrentRunsByState: { ...policy.maxConcurrentRunsByState },
    requireApprovalFor: [...policy.requireApprovalFor]
  };
}

export function defaultOrchestratorState(): OrchestratorState {
  return {
    mode: "autonomous",
    paused: false,
    policy: cloneAutomationPolicy(defaultAutomationPolicy),
    activeClaims: [],
    retryQueue: []
  };
}

export class OrchestratorStateStore {
  private readonly store: FileStateStore<OrchestratorState>;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<OrchestratorState>(
      path.join(appDataRoot, "state", "orchestrator.json"),
      defaultOrchestratorState()
    );
  }

  async read(): Promise<OrchestratorState> {
    const state = await this.store.read();
    return {
      ...defaultOrchestratorState(),
      ...state,
      policy: cloneAutomationPolicy({ ...defaultAutomationPolicy, ...state.policy }),
      activeClaims: state.activeClaims ?? [],
      retryQueue: state.retryQueue ?? []
    };
  }

  async write(state: OrchestratorState): Promise<void> {
    await this.store.write(state);
  }

  async update(mutator: (state: OrchestratorState) => OrchestratorState): Promise<OrchestratorState> {
    return this.enqueueUpdate(async () => {
      const current = await this.read();
      const next = mutator(current);
      await this.write(next);
      return next;
    });
  }

  private enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updateQueue.then(operation, operation);
    this.updateQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
