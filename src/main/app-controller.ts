import path from "node:path";
import type { HealthCheckResult, LinearConfig, Run, Task } from "../shared/types.js";
import { JsonlEventLog } from "./services/event-log.js";
import { LinearClient } from "./services/linear-client.js";
import { LinearConfigService } from "./services/linear-config-service.js";
import { ProfileService } from "./services/profiles.js";
import { RunService } from "./services/run-service.js";
import { TaskService } from "./services/task-service.js";
import { isoNow } from "./services/time.js";
import { WorkspaceManager } from "./services/workspace-manager.js";

export class AppController {
  readonly profiles: ProfileService;
  readonly tasks: TaskService;
  readonly runs: RunService;
  readonly linearConfig: LinearConfigService;
  readonly linear: LinearClient;
  readonly eventLog: JsonlEventLog;

  constructor(readonly appDataRoot: string) {
    this.profiles = new ProfileService({ appDataRoot });
    this.tasks = new TaskService(appDataRoot);
    this.linearConfig = new LinearConfigService(appDataRoot);
    this.linear = new LinearClient();
    this.eventLog = new JsonlEventLog(path.join(appDataRoot, "logs"));
    this.runs = new RunService(appDataRoot, this.eventLog, new WorkspaceManager({ workflowPath: path.join(process.cwd(), "WORKFLOW.md") }));
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
    const checks: HealthCheckResult[] = [await this.profiles.checkGlobalCodex(), await this.testLinearConnection()];
    for (const profile of profiles) {
      checks.push(await this.profiles.checkHealth(profile.id));
    }
    return checks;
  }
}

