# Autonomous Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Symphony Electron into a mostly autonomous Command Center that continuously pulls eligible work, runs bounded Codex app-server agents, tracks proof of work, opens or updates PR handoffs, and only interrupts the operator for high-risk actions.

**Architecture:** Keep the current Electron/Svelte shape and add a main-process orchestration layer around the existing services. The orchestrator owns authoritative dispatch state, scheduler ticks, retry/backoff, approvals, run reconciliation, and integration writebacks; the renderer becomes an operator cockpit over that state instead of directly driving every run.

**Tech Stack:** Electron 33, Svelte 5, TypeScript, Vitest, Playwright, Codex app-server JSON-RPC, Linear GraphQL, Git/GitHub CLI-compatible local workflows, JSON state files and JSONL event logs.

---

## Scope Check

This is a large feature, so implement it as three shippable milestones:

1. Autonomous daemon core: dispatch loop, state snapshot, retry/reconciliation, and run lifecycle.
2. Work completion loop: approval capture, proof-of-work extraction, PR/handoff metadata, and Linear/GitHub status writeback hooks.
3. Command Center cockpit: queue controls, policy controls, run timeline, approvals, proof panel, and workspace/artifact actions.

Each milestone must leave the app runnable and testable. Do not begin milestone 2 until milestone 1 passes `npm test` and `npm run typecheck`.

## Source-Grounded Gaps

Current app already has:

- Linear config and manual sync in `src/main/app-controller.ts` and `src/main/services/linear-client.ts`.
- Profile isolation and CODEX_HOME creation in `src/main/services/profiles.ts`.
- Workspace preparation in `src/main/services/workspace-manager.ts`.
- Codex app-server process launch in `src/main/services/codex-app-server.ts`.
- JSONL run logs in `src/main/services/event-log.ts`.
- A Svelte single-screen control plane in `src/renderer/src/App.svelte`.

Missing for mostly autonomous Symphony behavior:

- Scheduler is tested but not wired into `AppController`.
- No long-running poll loop, pause/resume, or persisted orchestrator state.
- No active run reconciliation, stale/stalled worker detection, or terminal tracker cleanup.
- No usable approval request store; `runs:respondToApproval` is a stub.
- Codex notifications are logged but not normalized into run state, proof, token/rate-limit data, or approval UI.
- No automatic handoff/PR status model.
- No Linear/GitHub writeback abstraction.
- Renderer has no automation mode, policy controls, approval queue, proof panel, or autonomous health summary.

## File Structure

- Create `src/main/services/orchestrator-state.ts`: persisted service state for paused/running flags, active issue claims, retry entries, scheduler counters, and policy.
- Create `src/main/services/orchestrator-service.ts`: long-running poll-and-dispatch loop that wires Linear, tasks, runs, scheduler, and reconciliation together.
- Create `src/main/services/approval-store.ts`: persisted approval requests and decisions.
- Create `src/main/services/proof-store.ts`: persisted proof-of-work artifacts for each run.
- Create `src/main/services/handoff-service.ts`: build PR/handoff metadata from run/workspace/proof state. It should not push or merge directly in the first pass.
- Create `src/main/services/integration-writeback.ts`: narrow interface for Linear/GitHub status updates, initially event-log backed with real adapters behind flags later.
- Modify `src/shared/types.ts`: add orchestrator, policy, approval, proof, and handoff types to the public IPC contract.
- Modify `src/main/app-controller.ts`: instantiate new services and expose orchestration methods.
- Modify `src/main/ipc.ts`: register IPC handlers for orchestrator, approvals, proof, and handoff.
- Modify `src/preload/index.ts`: expose the new API surface to the renderer.
- Modify `src/main/services/run-service.ts`: accept approval/proof callbacks, update run state from app-server events, and expose active-run metadata.
- Modify `src/main/services/codex-app-server.ts`: expose JSON-RPC request forwarding for approval responses and normalize key notifications.
- Modify `src/main/services/scheduler.ts`: add active-run release and retry reconciliation helpers; keep it deterministic and unit-tested.
- Modify `src/renderer/src/App.svelte`: split the Command Center into cockpit panels while keeping it in one file for this milestone.
- Create tests: `tests/orchestrator-state.test.ts`, `tests/orchestrator-service.test.ts`, `tests/approval-store.test.ts`, `tests/proof-store.test.ts`, `tests/handoff-service.test.ts`.
- Extend tests: `tests/scheduler.test.ts`, `tests/codex-jsonrpc.test.ts`, `tests/workspace-manager.test.ts`, `tests/ui/electron-smoke.spec.ts`.

---

### Task 1: Add Orchestrator State and Policy Types

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/main/services/orchestrator-state.ts`
- Test: `tests/orchestrator-state.test.ts`

- [ ] **Step 1: Write the failing state tests**

Add `tests/orchestrator-state.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { OrchestratorStateStore } from "../src/main/services/orchestrator-state.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-orchestrator-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("creates a default autonomous orchestrator state", async () => {
  const store = new OrchestratorStateStore(await tempRoot());
  const state = await store.read();

  expect(state.mode).toBe("autonomous");
  expect(state.paused).toBe(false);
  expect(state.policy.maxConcurrentRuns).toBe(2);
  expect(state.policy.autoStart).toBe(true);
  expect(state.policy.autoCreateHandoff).toBe(true);
  expect(state.retryQueue).toEqual([]);
});

test("updates state atomically and preserves retry entries", async () => {
  const store = new OrchestratorStateStore(await tempRoot());

  const updated = await store.update((state) => ({
    ...state,
    paused: true,
    retryQueue: [
      {
        taskId: "linear:lin-1",
        attempts: 2,
        nextAttemptAt: "2026-05-02T10:05:00.000Z",
        lastError: "temporary failure"
      }
    ]
  }));

  expect(updated.paused).toBe(true);
  expect((await store.read()).retryQueue[0]).toMatchObject({ attempts: 2, lastError: "temporary failure" });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/orchestrator-state.test.ts
```

Expected: fail because `OrchestratorStateStore` does not exist.

- [ ] **Step 3: Add shared types**

In `src/shared/types.ts`, add these types after `RunEvent`:

```ts
export type OrchestratorMode = "manual" | "autonomous";

export interface AutomationPolicy {
  autoStart: boolean;
  autoCreateHandoff: boolean;
  autoWriteTrackerUpdates: boolean;
  maxConcurrentRuns: number;
  pollIntervalSeconds: number;
  stallTimeoutSeconds: number;
  maxRetryBackoffSeconds: number;
  terminalStateNames: string[];
  requireApprovalFor: Array<"command" | "patch" | "network" | "filesystem" | "handoff" | "merge">;
}

export interface RetryQueueEntry {
  taskId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
}

export interface ActiveRunClaim {
  taskId: string;
  runId: string;
  identifier: string;
  startedAt: string;
  lastEventAt?: string;
}

export interface OrchestratorState {
  mode: OrchestratorMode;
  paused: boolean;
  policy: AutomationPolicy;
  activeClaims: ActiveRunClaim[];
  retryQueue: RetryQueueEntry[];
  lastTickAt?: string;
  lastError?: string;
}

export interface OrchestratorSnapshot {
  state: OrchestratorState;
  queuedTaskIds: string[];
  activeRuns: RunReference[];
}
```

Extend `SymphonyApi` with:

```ts
orchestrator: {
  snapshot(): Promise<OrchestratorSnapshot>;
  start(): Promise<OrchestratorState>;
  pause(): Promise<OrchestratorState>;
  resume(): Promise<OrchestratorState>;
  tick(): Promise<OrchestratorSnapshot>;
  updatePolicy(policy: Partial<AutomationPolicy>): Promise<OrchestratorState>;
};
```

- [ ] **Step 4: Add the state store implementation**

Create `src/main/services/orchestrator-state.ts`:

```ts
import path from "node:path";
import type { AutomationPolicy, OrchestratorState } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";

export const defaultAutomationPolicy: AutomationPolicy = {
  autoStart: true,
  autoCreateHandoff: true,
  autoWriteTrackerUpdates: false,
  maxConcurrentRuns: 2,
  pollIntervalSeconds: 60,
  stallTimeoutSeconds: 1800,
  maxRetryBackoffSeconds: 300,
  terminalStateNames: ["Done", "Canceled", "Cancelled", "Duplicate"],
  requireApprovalFor: ["merge"]
};

export function defaultOrchestratorState(): OrchestratorState {
  return {
    mode: "autonomous",
    paused: false,
    policy: defaultAutomationPolicy,
    activeClaims: [],
    retryQueue: []
  };
}

export class OrchestratorStateStore {
  private readonly store: FileStateStore<OrchestratorState>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<OrchestratorState>(path.join(appDataRoot, "state", "orchestrator.json"), defaultOrchestratorState());
  }

  async read(): Promise<OrchestratorState> {
    const state = await this.store.read();
    return {
      ...defaultOrchestratorState(),
      ...state,
      policy: { ...defaultAutomationPolicy, ...state.policy },
      activeClaims: state.activeClaims ?? [],
      retryQueue: state.retryQueue ?? []
    };
  }

  async write(state: OrchestratorState): Promise<void> {
    await this.store.write(state);
  }

  async update(mutator: (state: OrchestratorState) => OrchestratorState): Promise<OrchestratorState> {
    const current = await this.read();
    const next = mutator(current);
    await this.write(next);
    return next;
  }
}
```

- [ ] **Step 5: Run the test and commit**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/orchestrator-state.test.ts
```

Expected: pass.

Commit:

```powershell
git add src/shared/types.ts src/main/services/orchestrator-state.ts tests/orchestrator-state.test.ts
git commit -m "feat: add autonomous orchestrator state"
```

---

### Task 2: Wire the Autonomous Poll-and-Dispatch Loop

**Files:**
- Create: `src/main/services/orchestrator-service.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Test: `tests/orchestrator-service.test.ts`

- [ ] **Step 1: Write the failing service tests**

Create `tests/orchestrator-service.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { OrchestratorService } from "../src/main/services/orchestrator-service.js";
import { defaultOrchestratorState } from "../src/main/services/orchestrator-state.js";
import type { OrchestratorState, Run, Task } from "../src/shared/types.js";

function task(id: string, status = "Ready"): Task {
  return {
    id,
    source: "linear",
    externalId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    description: "",
    status,
    priority: 0,
    updatedAt: "2026-05-02T10:00:00.000Z"
  };
}

function run(id: string, taskId: string): Run {
  return {
    id,
    taskId,
    profileId: "profile-1",
    state: "running",
    updatedAt: "2026-05-02T10:00:00.000Z",
    startedAt: "2026-05-02T10:00:00.000Z"
  };
}

test("dispatches eligible Linear tasks up to the autonomous concurrency limit", async () => {
  let state: OrchestratorState = defaultOrchestratorState();
  const started: string[] = [];
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a"), task("b"), task("c")],
    listRuns: async () => [],
    startRun: async (candidate) => {
      started.push(candidate.id);
      return run(`run-${candidate.id}`, candidate.id);
    },
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(started).toEqual(["a", "b"]);
  expect(snapshot.state.activeClaims.map((claim) => claim.taskId)).toEqual(["a", "b"]);
  expect(snapshot.queuedTaskIds).toEqual(["c"]);
});

test("does not dispatch while paused", async () => {
  let state: OrchestratorState = { ...defaultOrchestratorState(), paused: true };
  const startRun = vi.fn();
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [task("a")],
    listRuns: async () => [],
    startRun,
    appendEvent: async () => undefined,
    now: () => new Date("2026-05-02T10:00:00.000Z")
  });

  const snapshot = await service.tick();

  expect(startRun).not.toHaveBeenCalled();
  expect(snapshot.queuedTaskIds).toEqual(["a"]);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/orchestrator-service.test.ts
```

Expected: fail because `OrchestratorService` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/main/services/orchestrator-service.ts`:

```ts
import type { OrchestratorSnapshot, OrchestratorState, Run, RunEventInput, Task } from "../../shared/types.js";

interface OrchestratorServiceOptions {
  readState(): Promise<OrchestratorState>;
  writeState(state: OrchestratorState): Promise<void>;
  listCandidateTasks(): Promise<Task[]>;
  listRuns(): Promise<Run[]>;
  startRun(task: Task): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<void>;
  now?: () => Date;
}

export class OrchestratorService {
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: OrchestratorServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<OrchestratorState> {
    const state = await this.options.readState();
    const next = { ...state, paused: false, mode: "autonomous" as const };
    await this.options.writeState(next);
    this.schedule(next.policy.pollIntervalSeconds);
    return next;
  }

  async pause(): Promise<OrchestratorState> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const state = await this.options.readState();
    const next = { ...state, paused: true };
    await this.options.writeState(next);
    return next;
  }

  async resume(): Promise<OrchestratorState> {
    return this.start();
  }

  async updatePolicy(patch: Partial<OrchestratorState["policy"]>): Promise<OrchestratorState> {
    const state = await this.options.readState();
    const next = { ...state, policy: { ...state.policy, ...patch } };
    await this.options.writeState(next);
    return next;
  }

  async snapshot(): Promise<OrchestratorSnapshot> {
    const state = await this.options.readState();
    return { state, queuedTaskIds: [], activeRuns: state.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId })) };
  }

  async tick(): Promise<OrchestratorSnapshot> {
    const state = await this.options.readState();
    const candidates = await this.options.listCandidateTasks();
    const runs = await this.options.listRuns();
    const activeTaskIds = new Set(runs.filter((run) => run.state === "running" || run.state === "preparing").map((run) => run.taskId));
    const activeClaims = state.activeClaims.filter((claim) => activeTaskIds.has(claim.taskId));
    const queuedTaskIds: string[] = [];
    const nextState: OrchestratorState = {
      ...state,
      activeClaims,
      lastTickAt: this.now().toISOString(),
      lastError: undefined
    };

    if (state.paused || !state.policy.autoStart) {
      queuedTaskIds.push(...candidates.filter((candidate) => !activeTaskIds.has(candidate.id)).map((candidate) => candidate.id));
      await this.options.writeState(nextState);
      return { state: nextState, queuedTaskIds, activeRuns: activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId })) };
    }

    for (const candidate of candidates) {
      if (activeTaskIds.has(candidate.id)) continue;
      const retry = state.retryQueue.find((r) => r.taskId === candidate.id);
      if (retry && new Date(retry.nextAttemptAt) > this.now()) continue;
      if (nextState.activeClaims.length >= state.policy.maxConcurrentRuns) {
        queuedTaskIds.push(candidate.id);
        continue;
      }

      try {
        const run = await this.options.startRun(candidate);
        nextState.activeClaims.push({
          taskId: candidate.id,
          runId: run.id,
          identifier: candidate.identifier,
          startedAt: run.startedAt ?? this.now().toISOString()
        });
        activeTaskIds.add(candidate.id);
        nextState.retryQueue = nextState.retryQueue.filter((r) => r.taskId !== candidate.id);
      } catch (error) {
        nextState.retryQueue.push({
          taskId: candidate.id,
          attempts: 1,
          nextAttemptAt: new Date(this.now().getTime() + 10_000).toISOString(),
          lastError: (error as Error).message
        });
      }
    }

    await this.options.writeState(nextState);
    return { state: nextState, queuedTaskIds, activeRuns: nextState.activeClaims.map((claim) => ({ id: claim.runId, taskId: claim.taskId })) };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        void this.options.readState().then((state) => {
          if (!state.paused) this.schedule(state.policy.pollIntervalSeconds);
        }).catch((err) => console.error("Orchestrator failed to read state", err));
      });
    }, Math.max(seconds, 5) * 1000);
  }
}
```

- [ ] **Step 4: Wire controller and IPC**

In `src/main/app-controller.ts`, instantiate `OrchestratorStateStore` and `OrchestratorService`. The `startRun` callback must use the first available profile:

```ts
this.orchestratorState = new OrchestratorStateStore(appDataRoot);
this.orchestrator = new OrchestratorService({
  readState: () => this.orchestratorState.read(),
  writeState: (state) => this.orchestratorState.write(state),
  listCandidateTasks: () => this.syncLinear(),
  listRuns: () => this.runs.list(),
  startRun: async (task) => {
    const profiles = await this.profiles.list();
    const profile = profiles[0];
    if (!profile) throw new Error("No Codex profile configured.");
    return this.startRun(task.id, profile.id);
  },
  appendEvent: (runId, event) => this.eventLog.append(runId, event)
});
```

Add class fields:

```ts
readonly orchestratorState: OrchestratorStateStore;
readonly orchestrator: OrchestratorService;
```

In `src/main/ipc.ts`, add:

```ts
ipcMain.handle("orchestrator:snapshot", () => controller.orchestrator.snapshot());
ipcMain.handle("orchestrator:start", () => controller.orchestrator.start());
ipcMain.handle("orchestrator:pause", () => controller.orchestrator.pause());
ipcMain.handle("orchestrator:resume", () => controller.orchestrator.resume());
ipcMain.handle("orchestrator:tick", () => controller.orchestrator.tick());
ipcMain.handle("orchestrator:updatePolicy", (_event, policy: Partial<AutomationPolicy>) => controller.orchestrator.updatePolicy(policy));
```

In `src/preload/index.ts`, add the matching `orchestrator` API methods using `invoke`.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/orchestrator-service.test.ts
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
```

Expected: both pass.

Commit:

```powershell
git add src/main/services/orchestrator-service.ts src/main/app-controller.ts src/main/ipc.ts src/preload/index.ts tests/orchestrator-service.test.ts
git commit -m "feat: wire autonomous orchestration loop"
```

---

### Task 3: Add Approval Capture and Response Flow

**Files:**
- Create: `src/main/services/approval-store.ts`
- Modify: `src/main/services/run-service.ts`
- Modify: `src/main/services/codex-app-server.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/approval-store.test.ts`

- [ ] **Step 1: Write the failing approval-store tests**

Create `tests/approval-store.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ApprovalStore } from "../src/main/services/approval-store.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-approvals-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("captures pending approval requests and records decisions", async () => {
  const store = new ApprovalStore(await tempRoot());
  const request = await store.create({
    runId: "run-1",
    kind: "command",
    title: "Run npm test",
    detail: "npm test",
    payload: { command: "npm test" }
  });

  expect((await store.listPending()).map((item) => item.id)).toEqual([request.id]);

  await store.respond(request.id, true);
  expect(await store.listPending()).toEqual([]);
  expect((await store.list()).find((item) => item.id === request.id)).toMatchObject({ approved: true });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/approval-store.test.ts
```

Expected: fail because `ApprovalStore` does not exist.

- [ ] **Step 3: Extend approval types**

In `src/shared/types.ts`, replace `ApprovalRequest` with:

```ts
export interface ApprovalRequest {
  id: string;
  runId: string;
  kind: "command" | "patch" | "tool" | "network" | "filesystem" | "handoff" | "merge" | "unknown";
  title: string;
  detail: string;
  payload: unknown;
  createdAt: string;
  respondedAt?: string;
  approved?: boolean;
}
```

Extend `SymphonyApi.runs` with:

```ts
listApprovals(runId?: string): Promise<ApprovalRequest[]>;
listPendingApprovals(): Promise<ApprovalRequest[]>;
```

- [ ] **Step 4: Implement the approval store**

Create `src/main/services/approval-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApprovalRequest } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

type ApprovalInput = Omit<ApprovalRequest, "id" | "createdAt" | "respondedAt" | "approved">;

export class ApprovalStore {
  private readonly store: FileStateStore<ApprovalRequest[]>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<ApprovalRequest[]>(path.join(appDataRoot, "state", "approvals.json"), []);
  }

  async create(input: ApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `approval-${randomUUID().slice(0, 12)}`,
      createdAt: isoNow(),
      ...input
    };
    const requests = await this.store.read();
    requests.push(request);
    await this.store.write(requests);
    return request;
  }

  async list(runId?: string): Promise<ApprovalRequest[]> {
    const requests = await this.store.read();
    return runId ? requests.filter((request) => request.runId === runId) : requests;
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return (await this.list()).filter((request) => request.approved === undefined);
  }

  async respond(requestId: string, approved: boolean): Promise<ApprovalRequest> {
    const requests = await this.store.read();
    const index = requests.findIndex((request) => request.id === requestId);
    if (index === -1) throw new Error(`Unknown approval request: ${requestId}`);
    const next = { ...requests[index], approved, respondedAt: isoNow() };
    requests[index] = next;
    await this.store.write(requests);
    return next;
  }
}
```

- [ ] **Step 5: Normalize Codex approval notifications**

In `src/main/services/run-service.ts`, add an optional dependency:

```ts
private readonly approvals?: ApprovalStore
```

When `onNotification` receives method names containing `request_approval`, `approval`, `file_change`, or `command_execution`, create an approval request with:

```ts
await this.approvals.create({
  runId: run.id,
  kind: inferApprovalKind(method, params),
  title: method,
  detail: JSON.stringify(params, null, 2).slice(0, 4000),
  payload: params
});
```

Keep app-server protocol forwarding simple in this task: store operator decisions and log them. Actual JSON-RPC response forwarding can be added after current generated protocol names are confirmed against live app-server events.

- [ ] **Step 6: Wire API and commit**

In `AppController`, instantiate `ApprovalStore` and implement:

```ts
async respondToApproval(requestId: string, approved: boolean): Promise<void> {
  const request = await this.approvals.respond(requestId, approved);
  await this.eventLog.append(request.runId, {
    type: "approval.responded",
    message: approved ? "Approval granted by operator." : "Approval denied by operator.",
    payload: request
  });
}
```

In `ipc.ts`, replace the stub:

```ts
ipcMain.handle("runs:respondToApproval", (_event, requestId: string, approved: boolean) => controller.respondToApproval(requestId, approved));
ipcMain.handle("runs:listApprovals", (_event, runId?: string) => controller.approvals.list(runId));
ipcMain.handle("runs:listPendingApprovals", () => controller.approvals.listPending());
```

In `preload/index.ts`, expose `listApprovals` and `listPendingApprovals`.

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/approval-store.test.ts
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
```

Commit:

```powershell
git add src/shared/types.ts src/main/services/approval-store.ts src/main/services/run-service.ts src/main/services/codex-app-server.ts src/main/app-controller.ts src/main/ipc.ts src/preload/index.ts tests/approval-store.test.ts
git commit -m "feat: capture command center approvals"
```

---

### Task 4: Add Proof-of-Work and Handoff Metadata

**Files:**
- Create: `src/main/services/proof-store.ts`
- Create: `src/main/services/handoff-service.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/services/run-service.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Test: `tests/proof-store.test.ts`
- Test: `tests/handoff-service.test.ts`

- [ ] **Step 1: Write failing proof tests**

Create `tests/proof-store.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProofStore } from "../src/main/services/proof-store.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-proof-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("records proof entries per run", async () => {
  const store = new ProofStore(await tempRoot());

  await store.add("run-1", { kind: "test", label: "npm test", status: "passed", detail: "42 passed" });
  await store.add("run-1", { kind: "review", label: "Code review", status: "pending", detail: "No review yet" });

  expect((await store.list("run-1")).map((entry) => entry.kind)).toEqual(["test", "review"]);
});
```

Create `tests/handoff-service.test.ts`:

```ts
import { expect, test } from "vitest";
import { HandoffService } from "../src/main/services/handoff-service.js";
import type { ProofEntry, Run, Task } from "../src/shared/types.js";

test("builds a handoff summary from task, run, and proof", () => {
  const task: Task = {
    id: "linear:lin-1",
    source: "linear",
    externalId: "lin-1",
    identifier: "ENG-42",
    title: "Implement dashboard",
    description: "Build the cockpit",
    status: "Ready",
    priority: 1,
    updatedAt: "2026-05-02T10:00:00.000Z",
    url: "https://linear.app/acme/issue/ENG-42"
  };
  const run: Run = {
    id: "run-1",
    taskId: task.id,
    profileId: "profile-1",
    state: "review",
    workspacePath: "C:/work/ENG-42",
    updatedAt: "2026-05-02T10:20:00.000Z"
  };
  const proof: ProofEntry[] = [{ id: "p1", runId: "run-1", kind: "test", label: "npm test", status: "passed", detail: "ok", createdAt: "2026-05-02T10:19:00.000Z" }];

  const handoff = new HandoffService().build({ task, run, proof });

  expect(handoff.title).toBe("ENG-42: Implement dashboard");
  expect(handoff.body).toContain("Linear: https://linear.app/acme/issue/ENG-42");
  expect(handoff.body).toContain("- [passed] npm test: ok");
});
```

- [ ] **Step 2: Add shared proof and handoff types**

In `src/shared/types.ts`, add:

```ts
export interface ProofEntry {
  id: string;
  runId: string;
  kind: "test" | "review" | "ci" | "diff" | "walkthrough" | "summary" | "error";
  label: string;
  status: "passed" | "failed" | "pending" | "unknown";
  detail: string;
  createdAt: string;
  url?: string;
}

export interface HandoffDraft {
  runId: string;
  taskId: string;
  title: string;
  body: string;
  branchName?: string;
  pullRequestUrl?: string;
  createdAt: string;
}
```

Extend `SymphonyApi`:

```ts
proof: {
  list(runId: string): Promise<ProofEntry[]>;
};
handoff: {
  build(runId: string): Promise<HandoffDraft>;
};
```

- [ ] **Step 3: Implement stores and service**

Create `src/main/services/proof-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProofEntry } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";
import { isoNow } from "./time.js";

type ProofInput = Omit<ProofEntry, "id" | "runId" | "createdAt">;

export class ProofStore {
  private readonly store: FileStateStore<ProofEntry[]>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<ProofEntry[]>(path.join(appDataRoot, "state", "proof.json"), []);
  }

  async add(runId: string, input: ProofInput): Promise<ProofEntry> {
    const entry: ProofEntry = {
      id: `proof-${randomUUID().slice(0, 12)}`,
      runId,
      createdAt: isoNow(),
      ...input
    };
    const entries = await this.store.read();
    entries.push(entry);
    await this.store.write(entries);
    return entry;
  }

  async list(runId: string): Promise<ProofEntry[]> {
    return (await this.store.read()).filter((entry) => entry.runId === runId);
  }
}
```

Create `src/main/services/handoff-service.ts`:

```ts
import type { HandoffDraft, ProofEntry, Run, Task } from "../../shared/types.js";
import { isoNow } from "./time.js";

export class HandoffService {
  build(input: { task: Task; run: Run; proof: ProofEntry[] }): HandoffDraft {
    const proofLines = input.proof.length
      ? input.proof.map((entry) => `- [${entry.status}] ${entry.label}: ${entry.detail}`).join("\n")
      : "- [unknown] No proof entries recorded.";

    return {
      runId: input.run.id,
      taskId: input.task.id,
      title: `${input.task.identifier}: ${input.task.title}`,
      createdAt: isoNow(),
      body: [
        `## ${input.task.identifier}: ${input.task.title}`,
        "",
        input.task.url ? `Linear: ${input.task.url}` : "Linear: not linked",
        input.run.workspacePath ? `Workspace: ${input.run.workspacePath}` : "Workspace: not available",
        "",
        "## Proof",
        proofLines,
        "",
        "## Operator Notes",
        "Review the workspace diff and proof entries before merge."
      ].join("\n")
    };
  }
}
```

- [ ] **Step 4: Extract proof from run events**

In `run-service.ts`, when the Codex notification method or stdout text contains test/CI/review signal words, add proof entries:

```ts
if (/test|typecheck|ci|review/i.test(method)) {
  await this.proof?.add(run.id, {
    kind: inferProofKind(method),
    label: method,
    status: inferProofStatus(params),
    detail: JSON.stringify(params).slice(0, 2000)
  });
}
```

Keep inference conservative:

```ts
function inferProofStatus(value: unknown): ProofEntry["status"] {
  const text = JSON.stringify(value).toLowerCase();
  if (text.includes("failed") || text.includes("error")) return "failed";
  if (text.includes("passed") || text.includes("success")) return "passed";
  return "unknown";
}
```

- [ ] **Step 5: Wire API and commit**

In `AppController`, instantiate `ProofStore` and `HandoffService`, then add:

```ts
async buildHandoff(runId: string): Promise<HandoffDraft> {
  const run = await this.runs.get(runId);
  const task = await this.tasks.get(run.taskId);
  const proof = await this.proof.list(runId);
  const handoff = this.handoff.build({ task, run, proof });
  await this.eventLog.append(runId, { type: "handoff.built", message: handoff.title, payload: handoff });
  return handoff;
}
```

Register IPC:

```ts
ipcMain.handle("proof:list", (_event, runId: string) => controller.proof.list(runId));
ipcMain.handle("handoff:build", (_event, runId: string) => controller.buildHandoff(runId));
```

Expose the same methods in `preload/index.ts`.

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/proof-store.test.ts tests/handoff-service.test.ts
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
```

Commit:

```powershell
git add src/shared/types.ts src/main/services/proof-store.ts src/main/services/handoff-service.ts src/main/services/run-service.ts src/main/app-controller.ts src/main/ipc.ts src/preload/index.ts tests/proof-store.test.ts tests/handoff-service.test.ts
git commit -m "feat: record run proof and handoff drafts"
```

---

### Task 5: Add Integration Writeback Boundary

**Files:**
- Create: `src/main/services/integration-writeback.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/services/orchestrator-service.ts`
- Test: `tests/integration-writeback.test.ts`

- [ ] **Step 1: Write the failing writeback tests**

Create `tests/integration-writeback.test.ts`:

```ts
import { expect, test } from "vitest";
import { EventLogWriteback } from "../src/main/services/integration-writeback.js";

test("records writeback intents without mutating external systems by default", async () => {
  const events: unknown[] = [];
  const writeback = new EventLogWriteback({
    appendEvent: async (_runId, event) => {
      events.push(event);
    }
  });

  await writeback.reportRunStarted({ runId: "run-1", taskId: "linear:lin-1", identifier: "ENG-42" });
  await writeback.reportHandoffReady({ runId: "run-1", taskId: "linear:lin-1", title: "ENG-42: Done" });

  expect(events).toMatchObject([
    { type: "writeback.run_started" },
    { type: "writeback.handoff_ready" }
  ]);
});
```

- [ ] **Step 2: Implement the writeback boundary**

Create `src/main/services/integration-writeback.ts`:

```ts
import type { RunEventInput } from "../../shared/types.js";

interface WritebackOptions {
  appendEvent(runId: string, event: RunEventInput): Promise<void>;
}

export interface RunStartedWriteback {
  runId: string;
  taskId: string;
  identifier: string;
}

export interface HandoffReadyWriteback {
  runId: string;
  taskId: string;
  title: string;
  url?: string;
}

export interface IntegrationWriteback {
  reportRunStarted(input: RunStartedWriteback): Promise<void>;
  reportHandoffReady(input: HandoffReadyWriteback): Promise<void>;
}

export class EventLogWriteback implements IntegrationWriteback {
  constructor(private readonly options: WritebackOptions) {}

  async reportRunStarted(input: RunStartedWriteback): Promise<void> {
    await this.options.appendEvent(input.runId, {
      type: "writeback.run_started",
      message: `Would update tracker: ${input.identifier} run started.`,
      payload: input
    });
  }

  async reportHandoffReady(input: HandoffReadyWriteback): Promise<void> {
    await this.options.appendEvent(input.runId, {
      type: "writeback.handoff_ready",
      message: `Would update tracker: ${input.title} ready for review.`,
      payload: input
    });
  }
}
```

- [ ] **Step 3: Wire writeback to orchestrator events**

In `AppController`, instantiate:

```ts
this.writeback = new EventLogWriteback({
  appendEvent: (runId, event) => this.eventLog.append(runId, event)
});
```

In `OrchestratorServiceOptions`, add optional:

```ts
reportRunStarted?(input: { runId: string; taskId: string; identifier: string }): Promise<void>;
```

After `startRun(candidate)` succeeds, call:

```ts
await this.options.reportRunStarted?.({ runId: run.id, taskId: candidate.id, identifier: candidate.identifier });
```

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/integration-writeback.test.ts tests/orchestrator-service.test.ts
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
```

Commit:

```powershell
git add src/main/services/integration-writeback.ts src/main/app-controller.ts src/main/services/orchestrator-service.ts tests/integration-writeback.test.ts tests/orchestrator-service.test.ts
git commit -m "feat: add integration writeback boundary"
```

---

### Task 6: Upgrade the Command Center Cockpit UI

**Files:**
- Modify: `src/renderer/src/App.svelte`
- Modify: `src/renderer/src/styles.css`
- Modify: `tests/ui/electron-smoke.spec.ts`

- [ ] **Step 1: Write a failing smoke test for autonomous controls**

Modify `tests/ui/electron-smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("packaged renderer shows the autonomous Symphony command center", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "Symphony" })).toBeVisible();
  await expect(page.getByText("Autonomous Command Center")).toBeVisible();
  await expect(page.getByRole("button", { name: /pause automation|resume automation/i })).toBeVisible();
  await expect(page.getByText("Approval queue")).toBeVisible();
  await expect(page.getByText("Proof of work")).toBeVisible();

  await app.close();
});
```

- [ ] **Step 2: Add renderer state loading**

In `src/renderer/src/App.svelte`, add state:

```ts
let orchestrator: OrchestratorSnapshot | undefined;
let approvals: ApprovalRequest[] = [];
let proof: ProofEntry[] = [];
let handoff: HandoffDraft | undefined;
```

Update `refresh()`:

```ts
orchestrator = await api.orchestrator.snapshot();
approvals = await api.runs.listPendingApprovals();
if (selectedRun?.id) proof = await api.proof.list(selectedRun.id);
```

Add actions:

```ts
async function toggleAutomation(): Promise<void> {
  await runAction(async () => {
    if (orchestrator?.state.paused) {
      await api.orchestrator.resume();
    } else {
      await api.orchestrator.pause();
    }
  }, orchestrator?.state.paused ? "Resuming automation" : "Pausing automation");
}

async function runTickNow(): Promise<void> {
  await runAction(async () => {
    orchestrator = await api.orchestrator.tick();
  }, "Running scheduler tick");
}

async function buildHandoff(): Promise<void> {
  if (!selectedRun) return;
  handoff = await api.handoff.build(selectedRun.id);
}
```

- [ ] **Step 3: Restructure the visible cockpit**

Keep the current two-column shell, but change the header title to:

```svelte
<p class="text-xs font-semibold uppercase tracking-wide text-stone-500">Mostly autonomous execution</p>
<h2 class="mt-1 text-2xl font-semibold tracking-tight">Autonomous Command Center</h2>
```

Add header buttons:

```svelte
<Button variant="secondary" on:click={runTickNow} disabled={busy}>
  <RefreshCw size={16} />
  Tick now
</Button>
<Button on:click={toggleAutomation} disabled={busy}>
  {orchestrator?.state.paused ? "Resume automation" : "Pause automation"}
</Button>
```

Add a policy card near Linear intake:

```svelte
<Card className="p-4">
  <div class="mb-3 flex items-center justify-between">
    <h3 class="font-semibold">Automation policy</h3>
    <Badge tone={orchestrator?.state.paused ? "warn" : "good"}>
      {orchestrator?.state.paused ? "Paused" : "Autonomous"}
    </Badge>
  </div>
  <div class="grid grid-cols-2 gap-3 text-sm">
    <div>
      <p class="text-xs uppercase tracking-wide text-stone-500">Concurrency</p>
      <p class="mt-1 font-medium">{orchestrator?.state.policy.maxConcurrentRuns ?? 0}</p>
    </div>
    <div>
      <p class="text-xs uppercase tracking-wide text-stone-500">Poll interval</p>
      <p class="mt-1 font-medium">{orchestrator?.state.policy.pollIntervalSeconds ?? 0}s</p>
    </div>
    <div>
      <p class="text-xs uppercase tracking-wide text-stone-500">Retries</p>
      <p class="mt-1 font-medium">{orchestrator?.state.retryQueue.length ?? 0}</p>
    </div>
    <div>
      <p class="text-xs uppercase tracking-wide text-stone-500">Active claims</p>
      <p class="mt-1 font-medium">{orchestrator?.state.activeClaims.length ?? 0}</p>
    </div>
  </div>
</Card>
```

Add an approval queue card:

```svelte
<Card className="p-4">
  <div class="mb-3 flex items-center justify-between">
    <h3 class="font-semibold">Approval queue</h3>
    <Badge tone={approvals.length ? "warn" : "good"}>{approvals.length}</Badge>
  </div>
  <div class="space-y-2">
    {#each approvals as approval}
      <div class="rounded-md border border-stone-200 bg-stone-50 p-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-sm font-medium">{approval.title}</p>
            <p class="mt-1 line-clamp-2 text-xs text-stone-500">{approval.detail}</p>
          </div>
          <Badge tone="warn">{approval.kind}</Badge>
        </div>
        <div class="mt-3 flex gap-2">
          <Button variant="secondary" className="h-8" on:click={() => api.runs.respondToApproval(approval.id, false).then(refresh)}>Deny</Button>
          <Button variant="primary" className="h-8" on:click={() => api.runs.respondToApproval(approval.id, true).then(refresh)}>Approve</Button>
        </div>
      </div>
    {:else}
      <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-500">No pending approvals.</p>
    {/each}
  </div>
</Card>
```

Add a proof panel beside the event stream:

```svelte
<Card className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
  <div class="flex items-center justify-between border-b border-stone-200 px-4 py-3">
    <h3 class="font-semibold">Proof of work</h3>
    <Button variant="ghost" className="h-8 px-2" on:click={buildHandoff} disabled={!selectedRun}>Handoff</Button>
  </div>
  <div class="min-h-0 overflow-auto p-3">
    {#each proof as entry}
      <div class="mb-2 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
        <div class="flex items-center justify-between">
          <span class="font-medium">{entry.label}</span>
          <Badge tone={entry.status === "passed" ? "good" : entry.status === "failed" ? "bad" : "neutral"}>{entry.status}</Badge>
        </div>
        <p class="mt-1 text-xs text-stone-500">{entry.detail}</p>
      </div>
    {:else}
      <p class="rounded-md border border-dashed border-stone-300 p-3 text-sm text-stone-500">Proof appears as runs report tests, CI, review, and summaries.</p>
    {/each}
    {#if handoff}
      <pre class="mt-3 whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{handoff.body}</pre>
    {/if}
  </div>
</Card>
```

- [ ] **Step 4: Run UI checks and commit**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run build
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run test:ui
```

Expected: typecheck, build, and smoke test pass.

Commit:

```powershell
git add src/renderer/src/App.svelte src/renderer/src/styles.css tests/ui/electron-smoke.spec.ts
git commit -m "feat: upgrade autonomous command center UI"
```

---

### Task 7: Reconciliation, Stall Detection, and Retry Hardening

**Files:**
- Modify: `src/main/services/orchestrator-service.ts`
- Modify: `src/main/services/run-service.ts`
- Modify: `tests/orchestrator-service.test.ts`
- Modify: `tests/scheduler.test.ts`

- [ ] **Step 1: Add failing reconciliation tests**

Extend `tests/orchestrator-service.test.ts`:

```ts
test("marks stale active claims for retry when runs exceed stall timeout", async () => {
  let state: OrchestratorState = {
    ...defaultOrchestratorState(),
    activeClaims: [
      {
        taskId: "a",
        runId: "run-a",
        identifier: "A",
        startedAt: "2026-05-02T09:00:00.000Z",
        lastEventAt: "2026-05-02T09:00:00.000Z"
      }
    ],
    policy: { ...defaultOrchestratorState().policy, stallTimeoutSeconds: 60 }
  };
  const service = new OrchestratorService({
    readState: async () => state,
    writeState: async (next) => {
      state = next;
    },
    listCandidateTasks: async () => [],
    listRuns: async () => [{ ...run("run-a", "a"), state: "running" }],
    startRun: async (candidate) => run(`run-${candidate.id}`, candidate.id),
    appendEvent: async () => undefined,
    terminateRun: async (runId) => {
      expect(runId).toBe("run-a");
    },
    now: () => new Date("2026-05-02T09:02:01.000Z")
  });

  const snapshot = await service.tick();

  expect(snapshot.state.activeClaims).toEqual([]);
  expect(snapshot.state.retryQueue[0]).toMatchObject({ taskId: "a", lastError: "stalled" });
});
```

- [ ] **Step 2: Implement termination hook and stall detection**

Add to `OrchestratorServiceOptions`:

```ts
terminateRun?(runId: string): Promise<void>;
```

At the start of `tick()`, before dispatch:

```ts
for (const claim of state.activeClaims) {
  const last = new Date(claim.lastEventAt ?? claim.startedAt).getTime();
  const stalled = state.policy.stallTimeoutSeconds > 0 && this.now().getTime() - last > state.policy.stallTimeoutSeconds * 1000;
  if (!stalled) continue;
  await this.options.terminateRun?.(claim.runId);
  const previous = state.retryQueue.find((r) => r.taskId === claim.taskId);
  const attempts = (previous?.attempts ?? 0) + 1;
  nextState.retryQueue = nextState.retryQueue.filter((r) => r.taskId !== claim.taskId);
  nextState.retryQueue.push({
    taskId: claim.taskId,
    attempts,
    nextAttemptAt: nextRetry(attempts, state.policy.maxRetryBackoffSeconds, this.now()),
    lastError: "stalled"
  });
}
nextState.activeClaims = nextState.activeClaims.filter((claim) => !nextState.retryQueue.some((retry) => retry.taskId === claim.taskId && retry.lastError === "stalled"));
```

Wire `terminateRun` in `AppController` to `this.runs.cancel(runId)`.

- [ ] **Step 3: Harden retry backoff**

When adding retry entries in `OrchestratorService`, calculate:

```ts
function nextRetry(attempts: number, maxBackoffSeconds: number, now: Date): string {
  const seconds = Math.min(10 * 2 ** Math.max(attempts - 1, 0), maxBackoffSeconds);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
```

Use existing retry attempt count for the task:

```ts
const previous = nextState.retryQueue.find((retry) => retry.taskId === candidate.id);
const attempts = (previous?.attempts ?? 0) + 1;
nextState.retryQueue = nextState.retryQueue.filter((retry) => retry.taskId !== candidate.id);
nextState.retryQueue.push({ taskId: candidate.id, attempts, nextAttemptAt: nextRetry(attempts, state.policy.maxRetryBackoffSeconds, this.now()), lastError });
```

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test -- tests/orchestrator-service.test.ts tests/scheduler.test.ts
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
```

Commit:

```powershell
git add src/main/services/orchestrator-service.ts src/main/app-controller.ts tests/orchestrator-service.test.ts tests/scheduler.test.ts
git commit -m "feat: harden autonomous reconciliation"
```

---

### Task 8: Final Verification and Documentation

**Files:**
- Modify: `README.md`
- Verify: full project

- [ ] **Step 1: Document autonomous operation**

Add to `README.md`:

```md
## Autonomous Command Center

The Command Center can run in mostly autonomous mode:

1. Configure a Codex profile and complete Codex OAuth.
2. Configure Linear with active state names such as `Ready`, `Todo`, and `In Progress`.
3. Use `Tick now` to test one scheduler cycle.
4. Use `Resume automation` to let Symphony poll Linear and start eligible runs up to the configured concurrency.
5. Review pending approvals, proof-of-work entries, handoff drafts, and run logs before merging external changes.

The first writeback implementation records intended tracker updates in the run event log. Direct Linear/GitHub mutation should remain behind explicit policy flags.
```

- [ ] **Step 2: Run the complete verification gate**

Run:

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm test
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run typecheck
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run build
$env:npm_config_cache=(Join-Path (Get-Location) '.npm-cache'); npm run test:ui
```

Expected: all pass. If `npm run test:ui` cannot launch Electron on the machine, capture the exact error and keep the unit/type/build results as the verified gate.

- [ ] **Step 3: Commit documentation and final fixes**

Commit:

```powershell
git add README.md
git commit -m "docs: explain autonomous command center operation"
```

---

## Self-Review

- Spec coverage: The plan covers continuous polling, bounded concurrency, authoritative orchestrator state, deterministic workspaces, retries/backoff, active-run reconciliation, observability, and mostly autonomous handoff/writeback behavior.
- Placeholder scan: The plan avoids TBD/TODO language and gives concrete files, commands, and code snippets for each task.
- Type consistency: Shared API additions are introduced before renderer and IPC usage; service method names are consistent across tasks.
- Scope control: Direct PR creation, merge automation, and live Linear/GitHub mutation are intentionally behind the writeback boundary. That keeps the first autonomous version safe enough to run while preserving extension points for full auto-landing.
