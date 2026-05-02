import path from "node:path";
import type { CodexAccountStatus, HealthCheckResult, LinearConfig, Run, SchedulerSnapshot, Task, WorkflowSnapshot, WorkflowValidation } from "../shared/types.js";
import { ApprovalService } from "./services/approval-service.js";
import { JsonlEventLog } from "./services/event-log.js";
import { LinearClient } from "./services/linear-client.js";
import { LinearConfigService } from "./services/linear-config-service.js";
import { OrchestrationService } from "./services/orchestration-service.js";
import { OrchestratorService } from "./services/orchestrator-service.js";
import { OrchestratorStateStore } from "./services/orchestrator-state.js";
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
  readonly workflow: WorkflowService;
  readonly scheduler: OrchestrationService;
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
    this.runs = new RunService(appDataRoot, this.eventLog, new WorkspaceManager({ workflow: this.workflow }), {
      approvals: this.approvals,
      onRunNeedsReview: (run) => this.markRunReadyForReview(run),
      onLinearGraphql: async (payload) => {
        const config = await this.linearConfig.get();
        return this.linear.graphql(config, payload);
      }
    });
    this.scheduler = new OrchestrationService({
      getLinearConfig: () => this.linearConfig.get(),
      syncLinear: () => this.syncLinear(),
      listProfiles: () => this.profiles.list(),
      checkProfileHealth: (profile) => this.profiles.checkHealth(profile.id),
      listRuns: () => this.runs.list(),
      startRun: (task, profile) => this.startRun(task.id, profile.id)
    });
    this.orchestratorState = new OrchestratorStateStore(appDataRoot);
    this.orchestrator = new OrchestratorService({
      readState: () => this.orchestratorState.read(),
      writeState: (state) => this.orchestratorState.write(state),
      listCandidateTasks: () => this.syncLinear(),
      listRuns: () => this.runs.list(),
      startRun: async (task) => {
        const [profile] = await this.profiles.list();
        if (!profile) {
          throw new Error("No Codex profile configured.");
        }
        return this.runs.start(task, profile);
      },
      appendEvent: (runId, event) => this.eventLog.append(runId, event)
    });
  }

  async saveLinearConfig(config: LinearConfig): Promise<LinearConfig> {
    return this.linearConfig.save(config);
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

  async transitionLinearIssue(issueId: string, stateName: string): Promise<void> {
    const config = await this.linearConfig.get();
    await this.linear.transitionIssue(config, issueId, stateName, config.teamKey);
  }

  async addLinearComment(issueId: string, body: string): Promise<void> {
    const config = await this.linearConfig.get();
    await this.linear.addComment(config, issueId, body);
  }

  async workflowSnapshot(): Promise<WorkflowSnapshot> {
    const workflow = await this.workflow.snapshot();
    const config = await this.linearConfig.get();
    return {
      ...workflow,
      pollIntervalSeconds: config.pollIntervalSeconds ?? workflow.pollIntervalSeconds,
      maxConcurrentRuns: config.maxConcurrentRuns ?? workflow.maxConcurrentRuns,
      activeStateNames: config.activeStateNames.length ? config.activeStateNames : workflow.activeStateNames,
      terminalStateNames: config.terminalStateNames?.length ? config.terminalStateNames : workflow.terminalStateNames
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

  startScheduler(): Promise<SchedulerSnapshot> {
    return this.scheduler.start();
  }

  stopScheduler(): SchedulerSnapshot {
    return this.scheduler.stop();
  }

  tickScheduler(): Promise<SchedulerSnapshot> {
    return this.scheduler.tick();
  }

  schedulerSnapshot(): SchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  private async markRunReadyForReview(run: Run): Promise<void> {
    try {
      const [task, config] = await Promise.all([this.tasks.get(run.taskId), this.linearConfig.get()]);
      if (task.source !== "linear" || !config.apiKey) return;
      const body = [
        `Symphony run ${run.id} completed and is ready for Human Review.`,
        run.workspacePath ? `Workspace: ${run.workspacePath}` : "",
        run.threadId ? `Codex thread: ${run.threadId}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      await this.linear.addComment(config, task.externalId, body);
      await this.linear.transitionIssue(config, task.externalId, config.humanReviewStateName ?? "Human Review", task.teamKey ?? config.teamKey);
      await this.eventLog.append(run.id, { type: "linear.review_gate", message: `Moved ${task.identifier} to Human Review.` });
    } catch (error) {
      await this.eventLog.append(run.id, { type: "linear.review_gate.failed", message: (error as Error).message });
    }
  }
}
