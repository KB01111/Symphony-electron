import type { AutomationPolicy, LinearConfig, Run, Task } from "../../shared/types.js";
import type { JsonlEventLog } from "./event-log.js";
import type { LinearClient } from "./linear-client.js";

interface WritebackOptions {
  linear: LinearClient;
  eventLog: JsonlEventLog;
  getLinearConfig(): Promise<LinearConfig>;
}

export class IntegrationWritebackService {
  constructor(private readonly options: WritebackOptions) {}

  async markRunReadyForReview(run: Run, task: Task): Promise<void> {
    const config = await this.options.getLinearConfig();
    if (task.source !== "linear" || !config.apiKey) return;
    await this.writeLinearReviewGate(config, run, task);
  }

  async writebackRun(config: LinearConfig, task: Task, run: Run, policy: AutomationPolicy): Promise<void> {
    if (task.source !== "linear" || !config.apiKey || !policy.autoWriteTrackerUpdates) return;
    await this.writeLinearReviewGate(config, run, task);
  }

  private async writeLinearReviewGate(config: LinearConfig, run: Run, task: Task): Promise<void> {
    const body = [
      `Symphony run ${run.id} completed and is ready for Human Review.`,
      run.workspacePath ? `Workspace: ${run.workspacePath}` : "",
      run.threadId ? `Codex thread: ${run.threadId}` : "",
      run.turnCount ? `Turns: ${run.turnCount}` : "",
      run.totalTokens ? `Total tokens: ${run.totalTokens}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    if (config.workflowManaged || config.humanReviewStateName) {
      await this.options.linear.addComment(config, task.externalId, body);
      if (config.humanReviewStateName) {
        await this.options.linear.transitionIssue(config, task.externalId, config.humanReviewStateName, task.teamKey ?? config.teamKey);
      }
      await this.options.eventLog.append(run.id, { type: "linear.review_gate", message: `Moved ${task.identifier} to Human Review.` });
    }
  }
}
