import path from "node:path";
import type {
  CodexAccountStatus,
  CreateIssueInput,
  GitHubConfig,
  GitHubPrStatus,
  HealthCheckResult,
  LandingDecision,
  LinearConfig,
  OrchestratorState,
  Profile,
  Run,
  SchedulerSnapshot,
  Task,
  WorkflowSnapshot,
  WorkflowValidation
} from "../shared/types.js";
import { ApprovalService } from "./services/approval-service.js";
import { JsonlEventLog } from "./services/event-log.js";
import { HandoffService } from "./services/handoff-service.js";
import { GitHubService } from "./services/github-service.js";
import { IntegrationWritebackService } from "./services/integration-writeback-service.js";
import { LandingService } from "./services/landing-service.js";
import { LinearClient } from "./services/linear-client.js";
import { LinearConfigService } from "./services/linear-config-service.js";
import { OrchestratorService } from "./services/orchestrator-service.js";
import { OrchestratorStateStore } from "./services/orchestrator-state.js";
import { ProofStore } from "./services/proof-store.js";
import { ProfileService } from "./services/profiles.js";
import { RunService } from "./services/run-service.js";
import { TaskService } from "./services/task-service.js";
import { isoNow } from "./services/time.js";
import { WorkspaceManager } from "./services/workspace-manager.js";
import { WorkflowService } from "./services/workflow-service.js";

export class AppController {
  readonly profiles: ProfileService;
  readonly tasks: TaskService;
  readonly runs: RunService;
  readonly linearConfig: LinearConfigService;
  readonly linear: LinearClient;
  readonly eventLog: JsonlEventLog;
  readonly approvals: ApprovalService;
  readonly proof: ProofStore;
  readonly handoff: HandoffService;
  readonly github: GitHubService;
  readonly landing: LandingService;
  readonly writeback: IntegrationWritebackService;
  readonly workflow: WorkflowService;
  readonly orchestratorState: OrchestratorStateStore;
  readonly orchestrator: OrchestratorService;

  constructor(readonly appDataRoot: string) {
    this.profiles = new ProfileService({ appDataRoot });
    this.tasks = new TaskService(appDataRoot);
    this.linearConfig = new LinearConfigService(appDataRoot);
    this.linear = new LinearClient();
    this.workflow = new WorkflowService(path.join(process.cwd(), "WORKFLOW.md"));
    this.eventLog = new JsonlEventLog(path.join(appDataRoot, "logs"));
    this.approvals = new ApprovalService(appDataRoot);
    this.proof = new ProofStore(appDataRoot);
    this.handoff = new HandoffService();
    this.github = new GitHubService();
    this.landing = new LandingService();
    this.writeback = new IntegrationWritebackService({
      linear: this.linear,
      eventLog: this.eventLog,
      getLinearConfig: () => this.linearConfig.get()
    });
    this.runs = new RunService(appDataRoot, this.eventLog, new WorkspaceManager({ workflow: this.workflow }), {
      approvals: this.approvals,
      proof: this.proof,
      onRunNeedsReview: (run) => this.markRunReadyForReview(run),
      shouldContinueRun: (run, task) => this.shouldContinueRun(run, task),
      onLinearGraphql: async (payload) => {
        const config = await this.linearConfig.get();
        return this.linear.graphql(config, payload);
      }
    });
    this.orchestratorState = new OrchestratorStateStore(appDataRoot);
    this.orchestrator = new OrchestratorService({
      readState: () => this.orchestratorState.read(),
      writeState: (state) => this.orchestratorState.write(state),
      listCandidateTasks: () => this.refreshLinearCandidates(),
      getIssueState: async (task) => {
        const config = await this.linearConfig.get();
        if (!config.apiKey || task.source !== "linear") return undefined;
        return this.linear.getIssueState(config, task.externalId);
      },
      listRuns: () => this.runs.list(),
      startRun: async (task) => {
        const profile = await this.selectHealthyProfile();
        if (!profile) {
          throw new Error("No healthy Codex profile configured.");
        }
        return this.runs.start(task, profile);
      },
      appendEvent: (runId, event) => this.eventLog.append(runId, event),
      terminateRun: (runId) => this.runs.cancel(runId),
      cleanWorkspace: async (task) => {
        const runs = await this.runs.list();
        const run = latestRunWithWorkspace(runs, task.id);
        if (run?.workspacePath) {
          await new WorkspaceManager({ workflow: this.workflow }).beforeRemove(run.workspacePath);
        }
      }
    });
  }

  async saveLinearConfig(config: LinearConfig): Promise<LinearConfig> {
    return this.linearConfig.save(config);
  }

  private async selectHealthyProfile(): Promise<Profile | undefined> {
    const profiles = await this.profiles.list();
    for (const profile of profiles) {
      const health = await this.profiles.checkHealth(profile.id);
      if (health.ok) {
        return profile;
      }
    }
    return undefined;
  }

  async testLinearConnection(config?: LinearConfig): Promise<HealthCheckResult> {
    const effective = config ?? (await this.linearConfig.get());
    if (!effective.apiKey) {
      return { ok: false, label: "Linear", detail: "Linear API key is not configured.", checkedAt: isoNow() };
    }
    return this.linear.testConnection(effective);
  }

  async listLinearIssues(config?: LinearConfig): Promise<Task[]> {
    const effective = config ?? (await this.linearConfig.get());
    if (!effective.apiKey) return [];
    return this.linear.listIssues(effective);
  }

  async syncLinear(): Promise<Task[]> {
    const issues = await this.listLinearIssues();
    return this.tasks.upsertMany(issues);
  }

  private async refreshLinearCandidates(): Promise<Task[]> {
    const issues = await this.listLinearIssues();
    await this.tasks.upsertMany(issues);
    return issues;
  }

  async transitionLinearIssue(issueId: string, stateName: string): Promise<void> {
    const config = await this.linearConfig.get();
    await this.linear.transitionIssue(config, issueId, stateName, config.teamKey);
  }

  async addLinearComment(issueId: string, body: string): Promise<void> {
    const config = await this.linearConfig.get();
    await this.linear.addComment(config, issueId, body);
  }

  async createLinearIssue(input: CreateIssueInput): Promise<Task> {
    const config = await this.linearConfig.get();
    const issue = await this.linear.createIssue(config, input);
    await this.tasks.upsertMany([issue]);
    return issue;
  }

  async workflowSnapshot(): Promise<WorkflowSnapshot> {
    const workflow = await this.workflow.snapshot();
    const config = await this.linearConfig.get();
    return {
      ...workflow,
      pollIntervalSeconds: config.pollIntervalSeconds ?? workflow.pollIntervalSeconds,
      maxConcurrentRuns: config.maxConcurrentRuns ?? workflow.maxConcurrentRuns,
      activeStateNames: config.activeStateNames.length ? config.activeStateNames : workflow.activeStateNames,
      terminalStateNames: config.terminalStateNames?.length ? config.terminalStateNames : workflow.terminalStateNames,
      ...(config.repositoryUrl ?? workflow.repositoryUrl ? { repositoryUrl: config.repositoryUrl ?? workflow.repositoryUrl } : {})
    };
  }

  async validateWorkflow(): Promise<WorkflowValidation> {
    return this.workflow.validate();
  }

  async startRun(taskId: string, profileId: string): Promise<Run> {
    const [task, profile] = await Promise.all([this.tasks.get(taskId), this.profiles.get(profileId)]);
    return this.runs.start(task, profile);
  }

  async retryRun(runId: string): Promise<Run> {
    const run = await this.runs.get(runId);
    const [task, profile] = await Promise.all([this.tasks.get(run.taskId), this.profiles.get(run.profileId)]);
    return this.runs.retry(run, task, profile);
  }

  async checkAllHealth(): Promise<HealthCheckResult[]> {
    const profiles = await this.profiles.list();
    const workflow = await this.validateWorkflow();
    const checks: HealthCheckResult[] = [
      await this.profiles.checkGlobalCodex(),
      await this.testLinearConnection(),
      {
        ok: workflow.ok,
        label: "WORKFLOW.md",
        detail: workflow.ok ? "Workflow file is valid." : workflow.errors.join("; "),
        checkedAt: workflow.checkedAt
      }
    ];
    for (const profile of profiles) {
      checks.push(await this.profiles.checkHealth(profile.id));
    }
    return checks;
  }

  async accountStatus(profileId: string): Promise<CodexAccountStatus> {
    const profile = await this.profiles.get(profileId);
    const health = await this.profiles.checkHealth(profileId);
    const status: CodexAccountStatus = {
      profileId,
      ok: health.ok,
      label: profile.name,
      detail: health.detail,
      checkedAt: health.checkedAt
    };
    if (health.ok) {
      status.account = "Codex CLI authenticated";
    }
    return status;
  }

  async startScheduler(): Promise<SchedulerSnapshot> {
    await this.resumeOrchestrator();
    return this.schedulerSnapshot();
  }

  async stopScheduler(): Promise<SchedulerSnapshot> {
    await this.pauseOrchestrator();
    return this.schedulerSnapshot();
  }

  tickScheduler(): Promise<SchedulerSnapshot> {
    return this.orchestrator.tick().then(orchestratorSnapshotToSchedulerSnapshot);
  }

  async schedulerSnapshot(): Promise<SchedulerSnapshot> {
    return orchestratorSnapshotToSchedulerSnapshot(await this.orchestrator.snapshot());
  }

  async startOrchestrator(): Promise<OrchestratorState> {
    return this.orchestrator.start();
  }

  async pauseOrchestrator(): Promise<OrchestratorState> {
    return this.orchestrator.pause();
  }

  async resumeOrchestrator(): Promise<OrchestratorState> {
    return this.orchestrator.resume();
  }

  async buildHandoff(runId: string) {
    const run = await this.runs.get(runId);
    const [task, proof, transcript] = await Promise.all([this.tasks.get(run.taskId), this.proof.list(runId), this.runs.getTranscript(runId)]);
    const transcriptSummary = [...transcript].reverse().find((item) => item.role === "agent" || item.role === "system")?.text;
    const draft = this.handoff.build({
      task,
      run,
      proof,
      ...(transcriptSummary ? { transcriptSummary } : {})
    });
    await this.eventLog.append(runId, { type: "handoff.built", message: draft.title, payload: draft });
    return draft;
  }

  async githubStatus(runId: string): Promise<GitHubPrStatus> {
    const run = await this.runs.get(runId);
    const task = await this.tasks.get(run.taskId);
    const status = await this.github.status(run, task, githubConfigForTask(task));
    await this.proof.add(runId, {
      kind: "github_check",
      label: "GitHub status",
      status: status.checksStatus,
      detail: status.detail,
      source: "github-status",
      ...(status.prUrl ? { url: status.prUrl } : {}),
      metadata: { ...status }
    });
    return status;
  }

  async approveLanding(runId: string, reason?: string): Promise<LandingDecision> {
    const run = await this.runs.get(runId);
    const [task, orchestratorState] = await Promise.all([this.tasks.get(run.taskId), this.orchestratorState.read()]);
    const status = await this.github.status(run, task, githubConfigForTask(task));
    const decision = this.landing.approve(run, status, orchestratorState.policy, reason);
    if (this.landing.canAutoMerge(orchestratorState.policy, status, decision) && status.prNumber) {
      const config = githubConfigForTask(task);
      if (config) {
        await this.github.merge(config, status.prNumber);
      }
    }
    await this.proof.add(runId, {
      kind: "landing",
      label: "Landing decision",
      status: decision.approved ? "passed" : "warning",
      detail: decision.reason ?? (decision.approved ? "Landing approved by operator." : "Run is not ready for landing."),
      source: "landing-decision",
      metadata: { ...decision }
    });
    await this.eventLog.append(runId, { type: "landing.decision", message: decision.approved ? "Landing approved." : "Landing not approved.", payload: decision });
    return decision;
  }

  private async markRunReadyForReview(run: Run): Promise<void> {
    try {
      const task = await this.tasks.get(run.taskId);
      await this.writeback.markRunReadyForReview(run, task);
    } catch (error) {
      await this.eventLog.append(run.id, { type: "linear.review_gate.failed", message: (error as Error).message });
    }
  }

  private async shouldContinueRun(run: Run, task: Task): Promise<boolean> {
    const config = await this.linearConfig.get();
    if (!config.apiKey || task.source !== "linear") return false;
    const state = await this.linear.getIssueState(config, task.externalId);
    if (!state) return false;
    const terminal = new Set((config.terminalStateNames ?? []).map((name) => name.trim().toLowerCase()));
    return !terminal.has(state.status.trim().toLowerCase()) && (run.turnCount ?? 1) > 0;
  }
}

/**
 * Convert an orchestrator snapshot into the scheduler's snapshot shape.
 *
 * @param snapshot - The orchestrator snapshot produced by `OrchestratorService.snapshot()`
 * @returns A SchedulerSnapshot containing `enabled`, `running`, `queuedTaskIds`, `retryQueue`, and optional `lastPollAt` and `lastError`
 */
function orchestratorSnapshotToSchedulerSnapshot(snapshot: Awaited<ReturnType<OrchestratorService["snapshot"]>>): SchedulerSnapshot {
  return {
    enabled: !snapshot.state.paused && snapshot.state.policy.autoStart,
    running: snapshot.activeRuns,
    queuedTaskIds: snapshot.queuedTaskIds,
    retryQueue: snapshot.state.retryQueue.map((entry) => ({ ...entry })),
    ...(snapshot.state.lastTickAt ? { lastPollAt: snapshot.state.lastTickAt } : {}),
    ...(snapshot.state.lastError ? { lastError: snapshot.state.lastError } : {})
  };
}

export function latestRunWithWorkspace(runs: Run[], taskId: string): Run | undefined {
  return runs
    .filter((run) => run.taskId === taskId && run.workspacePath && run.state !== "cancelled" && run.state !== "failed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function githubConfigForTask(task: Task): GitHubConfig | undefined {
  const repositoryUrl = task.repositoryUrl ?? inferRepositoryUrl(task.description);
  if (!repositoryUrl) return undefined;
  const match = repositoryUrl.match(/github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/\s]+)(?:\.git)?/u);
  const owner = match?.groups?.owner;
  const repo = match?.groups?.repo;
  if (!owner || !repo) return undefined;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    owner,
    repo,
    ...(token ? { token } : {})
  };
}

function inferRepositoryUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/github\.com\/[^\s/]+\/[^\s)]+/u);
  return match?.[0]?.replace(/\/pull\/\d+.*/u, "");
}
