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

export interface ApprovalRequest {
  id: string;
  runId: string;
  kind: "command" | "patch" | "tool" | "unknown";
  title: string;
  detail: string;
  payload: unknown;
  createdAt: string;
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
    respondToApproval(requestId: string, approved: boolean): Promise<void>;
  };
  logs: {
    tail(runId: string): Promise<RunEvent[]>;
    export(runId: string): Promise<string>;
  };
  health: {
    checkAll(): Promise<HealthCheckResult[]>;
  };
}
