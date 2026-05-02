import { BrowserWindow, ipcMain } from "electron";
import type { AppController } from "./app-controller.js";
import type { AutomationPolicy, LinearConfig, Task } from "../shared/types.js";
import { eventToTranscriptItem } from "../shared/transcript.js";

export function registerIpc(controller: AppController): void {
  controller.eventLog.onAppend((event) => {
    const transcriptItem = eventToTranscriptItem(event);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("events:runEvent", event);
      window.webContents.send("events:transcriptItem", transcriptItem);
    }
  });
  controller.scheduler.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("events:scheduler", snapshot);
    }
  });

  ipcMain.handle("profiles:list", () => controller.profiles.list());
  ipcMain.handle("profiles:create", (_event, input: { name: string }) => controller.profiles.create(input));
  ipcMain.handle("profiles:startLogin", (_event, profileId: string) => controller.profiles.startLogin(profileId));
  ipcMain.handle("profiles:checkHealth", (_event, profileId: string) => controller.profiles.checkHealth(profileId));
  ipcMain.handle("profiles:accountStatus", (_event, profileId: string) => controller.accountStatus(profileId));

  ipcMain.handle("linear:getConfig", () => controller.linearConfig.get());
  ipcMain.handle("linear:saveConfig", (_event, config: LinearConfig) => controller.saveLinearConfig(config));
  ipcMain.handle("linear:testConnection", (_event, config?: LinearConfig) => controller.testLinearConnection(config));
  ipcMain.handle("linear:listIssues", (_event, config?: LinearConfig) => controller.listLinearIssues(config));
  ipcMain.handle("linear:syncNow", () => controller.syncLinear());
  ipcMain.handle("linear:transitionIssue", (_event, issueId: string, stateName: string) => controller.transitionLinearIssue(issueId, stateName));
  ipcMain.handle("linear:addComment", (_event, issueId: string, body: string) => controller.addLinearComment(issueId, body));

  ipcMain.handle("workflow:snapshot", () => controller.workflowSnapshot());
  ipcMain.handle("workflow:validate", () => controller.validateWorkflow());

  ipcMain.handle("scheduler:start", () => controller.startScheduler());
  ipcMain.handle("scheduler:stop", () => controller.stopScheduler());
  ipcMain.handle("scheduler:tick", () => controller.tickScheduler());
  ipcMain.handle("scheduler:snapshot", () => controller.schedulerSnapshot());

  ipcMain.handle("tasks:list", () => controller.tasks.list());
  ipcMain.handle("tasks:enqueueFromLinear", (_event, task: Task) => controller.tasks.upsert(task));
  ipcMain.handle("tasks:archive", (_event, taskId: string) => controller.tasks.archive(taskId));

  ipcMain.handle("runs:list", () => controller.runs.list());
  ipcMain.handle("runs:start", (_event, taskId: string, profileId: string) => controller.startRun(taskId, profileId));
  ipcMain.handle("runs:cancel", (_event, runId: string) => controller.runs.cancel(runId));
  ipcMain.handle("runs:retry", (_event, runId: string) => controller.retryRun(runId));
  ipcMain.handle("runs:getEvents", (_event, runId: string) => controller.eventLog.replay(runId));
  ipcMain.handle("runs:getTranscript", (_event, runId: string) => controller.runs.getTranscript(runId));
  ipcMain.handle("runs:listApprovals", (_event, runId?: string) => controller.runs.listApprovals(runId));
  ipcMain.handle("runs:listPendingApprovals", () => controller.approvals.listPending());
  ipcMain.handle("runs:respondToApproval", (_event, requestId: string, approved: boolean) => controller.runs.respondToApproval(requestId, approved));

  ipcMain.handle("orchestrator:snapshot", () => controller.orchestrator.snapshot());
  ipcMain.handle("orchestrator:start", () => controller.orchestrator.start());
  ipcMain.handle("orchestrator:pause", () => controller.orchestrator.pause());
  ipcMain.handle("orchestrator:resume", () => controller.orchestrator.resume());
  ipcMain.handle("orchestrator:tick", () => controller.orchestrator.tick());
  ipcMain.handle("orchestrator:updatePolicy", (_event, policy: Partial<AutomationPolicy>) => controller.orchestrator.updatePolicy(policy));

  ipcMain.handle("logs:tail", (_event, runId: string) => controller.eventLog.replay(runId));
  ipcMain.handle("logs:export", (_event, runId: string) => controller.eventLog.exportPath(runId));

  ipcMain.handle("health:checkAll", () => controller.checkAllHealth());
}
