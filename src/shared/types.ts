export type TaskSource = "linear" | "local" | "github";

export type RunState = "queued" | "preparing" | "running" | "stalled" | "failed" | "review" | "done" | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalKind = "command" | "patch" | "tool" | "network" | "filesystem" | "handoff" | "merge" | "unknown";

export interface Profile {
  id: string;
  name: string;
  codexHome: string;
  workspaceRoot: string;
  repoCacheRoot: string;
  logsRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  name: string;
}

export interface LinearConfig {
  apiKey: string;
  teamKey?: string;
  projectSlug?: string;
  projectName?: string;
  activeStateNames: string[];
  terminalStateNames?: string[];
  inProgressStateName?: string;
  humanReviewStateName?: string;
  pollIntervalSeconds?: number;
  maxConcurrentRuns?: number;
  repositoryUrl?: string;
}

export interface LinearBlocker {
  id?: string;
  identifier?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Task {
  id: string;
  source: TaskSource;
  externalId: string;
  identifier: string;
  title: string;
  description: string;
  url?: string;
  status: string;
  priority: number;
  assignee?: string;
  teamKey?: string;
  projectName?: string;
  repositoryUrl?: string;
  labels?: string[];
  blockers?: LinearBlocker[];
  branchName?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface WorkspaceRef {
  path: string;
  promptPath?: string;
  workflowPrompt: string;
  repoCachePath?: string;
}

export interface Run {
  id: string;
  taskId: string;
  profileId: string;
  state: RunState;
  workspacePath?: string;
  threadId?: string;
  turnId?: string;
  attempt?: number;
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface RunReference {
  id: string;
  taskId: string;
  profileId?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  timestamp: string;
  type: string;
  message?: string;
  stream?: "stdout" | "stderr";
  payload?: unknown;
}

export interface RunTranscriptItem {
  id: string;
  runId: string;
  timestamp: string;
  role: "user" | "agent" | "reasoning" | "tool" | "system";
  title: string;
  text: string;
}

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
  requireApprovalFor: Array<Exclude<ApprovalKind, "tool" | "unknown">>;
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

export interface ApprovalRequest {
  id: string;
  runId: string;
  protocolRequestId?: string | number;
  protocolMethod?: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  payload: unknown;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  label: string;
  detail: string;
  checkedAt: string;
}

export interface CodexAccountStatus {
  profileId: string;
  ok: boolean;
  label: string;
  detail: string;
  checkedAt: string;
  account?: string;
  rateLimitSummary?: string;
}

export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
  checkedAt: string;
}

export interface WorkflowSnapshot {
  path: string;
  validation: WorkflowValidation;
  pollIntervalSeconds: number;
  maxConcurrentRuns: number;
  activeStateNames: string[];
  terminalStateNames: string[];
}

export interface RetryEntry {
  taskId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
}

export interface SchedulerSnapshot {
  enabled: boolean;
  running: RunReference[];
  queuedTaskIds: string[];
  retryQueue: RetryEntry[];
  lastPollAt?: string;
  nextPollAt?: string;
  lastError?: string;
}

export interface SymphonySnapshot {
  profiles: Profile[];
  tasks: Task[];
  runs: Run[];
  health: HealthCheckResult[];
  scheduler?: SchedulerSnapshot;
  workflow?: WorkflowSnapshot;
}

export interface SymphonyApi {
  profiles: {
    list(): Promise<Profile[]>;
    create(input: CreateProfileInput): Promise<Profile>;
    startLogin(profileId: string): Promise<{ pid?: number; message: string }>;
    checkHealth(profileId: string): Promise<HealthCheckResult>;
    accountStatus(profileId: string): Promise<CodexAccountStatus>;
  };
  linear: {
    getConfig(): Promise<LinearConfig>;
    saveConfig(config: LinearConfig): Promise<LinearConfig>;
    testConnection(config?: LinearConfig): Promise<HealthCheckResult>;
    listIssues(config?: LinearConfig): Promise<Task[]>;
    syncNow(): Promise<Task[]>;
    transitionIssue(issueId: string, stateName: string): Promise<void>;
    addComment(issueId: string, body: string): Promise<void>;
  };
  workflow: {
    snapshot(): Promise<WorkflowSnapshot>;
    validate(): Promise<WorkflowValidation>;
  };
  scheduler: {
    start(): Promise<SchedulerSnapshot>;
    stop(): Promise<SchedulerSnapshot>;
    tick(): Promise<SchedulerSnapshot>;
    snapshot(): Promise<SchedulerSnapshot>;
  };
  tasks: {
    list(): Promise<Task[]>;
    enqueueFromLinear(task: Task): Promise<Task>;
    archive(taskId: string): Promise<void>;
  };
  runs: {
    list(): Promise<Run[]>;
    start(taskId: string, profileId: string): Promise<Run>;
    cancel(runId: string): Promise<Run>;
    retry(runId: string): Promise<Run>;
    getEvents(runId: string): Promise<RunEvent[]>;
    getTranscript(runId: string): Promise<RunTranscriptItem[]>;
    listApprovals(runId?: string): Promise<ApprovalRequest[]>;
    listPendingApprovals(): Promise<ApprovalRequest[]>;
    respondToApproval(requestId: string, approved: boolean): Promise<void>;
  };
  orchestrator: {
    snapshot(): Promise<OrchestratorSnapshot>;
    start(): Promise<OrchestratorState>;
    pause(): Promise<OrchestratorState>;
    resume(): Promise<OrchestratorState>;
    tick(): Promise<OrchestratorSnapshot>;
    updatePolicy(policy: Partial<AutomationPolicy>): Promise<OrchestratorState>;
  };
  logs: {
    tail(runId: string): Promise<RunEvent[]>;
    export(runId: string): Promise<string>;
  };
  health: {
    checkAll(): Promise<HealthCheckResult[]>;
  };
  events: {
    onRunEvent(callback: (event: RunEvent) => void): () => void;
    onTranscriptItem(callback: (item: RunTranscriptItem) => void): () => void;
    onScheduler(callback: (snapshot: SchedulerSnapshot) => void): () => void;
  };
}
