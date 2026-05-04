export type TaskSource = "linear" | "local" | "github";

export type RunState = "queued" | "preparing" | "running" | "stalled" | "failed" | "review" | "done" | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalKind = "command" | "patch" | "tool" | "network" | "filesystem" | "handoff" | "merge" | "unknown";

export type QueueReason = "blocked" | "paused" | "policy_disabled" | "concurrency" | "state_concurrency" | "retry" | "already_running" | "missing_profile";

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
  workflowManaged?: boolean;
}

export interface LinearBlocker {
  id?: string;
  identifier?: string;
  state?: string;
  relationType?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  teamKey?: string;
  projectName?: string;
  stateName?: string;
  labels?: string[];
  parentIssueId?: string;
}

export interface GitHubConfig {
  token?: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
}

export interface CreatePrInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
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
  runtime: CodexRuntimeConfig;
}

export interface CodexRuntimeConfig {
  command: string;
  approvalPolicy?: unknown;
  threadSandbox?: unknown;
  turnSandboxPolicy?: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  maxTurns: number;
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
  turnCount?: number;
  pid?: number;
  lastCodexEvent?: string;
  lastCodexMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
  autoTransitionInProgress: boolean;
  autoCreateHandoff: boolean;
  autoWriteTrackerUpdates: boolean;
  autoCreatePr: boolean;
  autoUpdatePr: boolean;
  autoMerge: boolean;
  requireApprovalForLanding: boolean;
  trustedEnvironment: boolean;
  allowedRepositories: string[];
  maxConcurrentRuns: number;
  maxConcurrentRunsByState: Record<string, number>;
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

export interface QueuedTask {
  taskId: string;
  identifier: string;
  reason: QueueReason;
  detail?: string;
  nextAttemptAt?: string;
}

export interface ActiveRunMetric extends RunReference {
  identifier?: string;
  startedAt?: string;
  lastEventAt?: string;
  turnCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface OrchestratorSnapshot {
  state: OrchestratorState;
  queuedTaskIds: string[];
  queue: QueuedTask[];
  activeRuns: RunReference[];
  activeMetrics: ActiveRunMetric[];
  nextPollAt?: string;
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

export type ProofKind =
  | "test"
  | "ci"
  | "review"
  | "diff"
  | "pr"
  | "github_check"
  | "pr_review"
  | "complexity"
  | "walkthrough_video"
  | "artifact"
  | "landing"
  | "token_usage"
  | "rate_limit"
  | "summary";

export type ProofStatus = "passed" | "failed" | "warning" | "unknown";

export interface ProofEntry {
  id: string;
  runId: string;
  kind: ProofKind;
  label: string;
  status: ProofStatus;
  detail: string;
  source?: string;
  url?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface ProofInput {
  kind: ProofKind;
  label: string;
  status: ProofStatus;
  detail: string;
  source?: string;
  url?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface HandoffDraft {
  runId: string;
  taskId: string;
  title: string;
  body: string;
  branchName?: string;
  prUrl?: string;
  proofSummary?: string;
  diffSummary?: string;
  landingAllowed: boolean;
  createdAt: string;
}

export interface GitHubPrStatus {
  runId: string;
  taskId: string;
  repositoryUrl?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  checksStatus: ProofStatus;
  reviewStatus: ProofStatus;
  detail: string;
  updatedAt: string;
}

export interface LandingDecision {
  runId: string;
  approved: boolean;
  reason?: string;
  decidedAt: string;
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
  maxTurns: number;
  activeStateNames: string[];
  terminalStateNames: string[];
  repositoryUrl?: string;
  autoCreatePr?: boolean;
  autoMerge?: boolean;
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
    createIssue(input: CreateIssueInput): Promise<Task>;
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
  proof: {
    list(runId: string): Promise<ProofEntry[]>;
    listAll(): Promise<ProofEntry[]>;
  };
  handoff: {
    build(runId: string): Promise<HandoffDraft>;
  };
  github: {
    status(runId: string): Promise<GitHubPrStatus>;
  };
  landing: {
    approve(runId: string, reason?: string): Promise<LandingDecision>;
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
