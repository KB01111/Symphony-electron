export type TaskSource = "linear" | "local" | "github";

export type RunState = "queued" | "preparing" | "running" | "stalled" | "failed" | "review" | "done" | "cancelled";

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
  activeStateNames: string[];
  pollIntervalSeconds?: number;
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
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface RunReference {
  id: string;
  taskId: string;
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

export type OrchestratorMode = "manual" | "autonomous";

export type ApprovalKind = "command" | "patch" | "tool" | "network" | "filesystem" | "handoff" | "merge" | "unknown";

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
  createdAt: string;
  respondedAt?: string;
  approved?: boolean;
}

export interface HealthCheckResult {
  ok: boolean;
  label: string;
  detail: string;
  checkedAt: string;
}

export interface SymphonySnapshot {
  profiles: Profile[];
  tasks: Task[];
  runs: Run[];
  health: HealthCheckResult[];
}

export interface SymphonyApi {
  profiles: {
    list(): Promise<Profile[]>;
    create(input: CreateProfileInput): Promise<Profile>;
    startLogin(profileId: string): Promise<{ pid?: number; message: string }>;
    checkHealth(profileId: string): Promise<HealthCheckResult>;
  };
  linear: {
    saveConfig(config: LinearConfig): Promise<LinearConfig>;
    testConnection(config?: LinearConfig): Promise<HealthCheckResult>;
    listIssues(config?: LinearConfig): Promise<Task[]>;
    syncNow(): Promise<Task[]>;
  };
  tasks: {
    list(): Promise<Task[]>;
    enqueueFromLinear(task: Task): Promise<Task>;
    archive(taskId: string): Promise<void>;
  };
  runs: {
    start(taskId: string, profileId: string): Promise<Run>;
    cancel(runId: string): Promise<Run>;
    retry(runId: string): Promise<Run>;
    getEvents(runId: string): Promise<RunEvent[]>;
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
}
