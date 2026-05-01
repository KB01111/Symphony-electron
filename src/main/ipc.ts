import { ipcMain } from "electron";
import type { AppController } from "./app-controller.js";
import type { LinearConfig, Task } from "../shared/types.js";

export function registerIpc(controller: AppController): void {
  ipcMain.handle("profiles:list", () => controller.profiles.list());
  ipcMain.handle("profiles:create", (_event, input: { name: string }) => controller.profiles.create(input));
  ipcMain.handle("profiles:startLogin", (_event, profileId: string) => controller.profiles.startLogin(profileId));
  ipcMain.handle("profiles:checkHealth", (_event, profileId: string) => controller.profiles.checkHealth(profileId));

  ipcMain.handle("linear:saveConfig", (_event, config: LinearConfig) => controller.saveLinearConfig(config));
  ipcMain.handle("linear:testConnection", (_event, config?: LinearConfig) => controller.testLinearConnection(config));
  ipcMain.handle("linear:listIssues", (_event, config?: LinearConfig) => controller.listLinearIssues(config));
  ipcMain.handle("linear:syncNow", () => controller.syncLinear());

  ipcMain.handle("tasks:list", () => controller.tasks.list());
  ipcMain.handle("tasks:enqueueFromLinear", (_event, task: Task) => controller.tasks.upsert(task));
  ipcMain.handle("tasks:archive", (_event, taskId: string) => controller.tasks.archive(taskId));

  ipcMain.handle("runs:start", (_event, taskId: string, profileId: string) => controller.startRun(taskId, profileId));
  ipcMain.handle("runs:cancel", (_event, runId: string) => controller.runs.cancel(runId));
  ipcMain.handle("runs:retry", (_event, runId: string) => controller.retryRun(runId));
  ipcMain.handle("runs:getEvents", (_event, runId: string) => controller.eventLog.replay(runId));
  ipcMain.handle("runs:respondToApproval", async () => undefined);

  ipcMain.handle("logs:tail", (_event, runId: string) => controller.eventLog.replay(runId));
  ipcMain.handle("logs:export", (_event, runId: string) => controller.eventLog.exportPath(runId));

  ipcMain.handle("health:checkAll", () => controller.checkAllHealth());
}

