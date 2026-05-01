import { contextBridge, ipcRenderer } from "electron";
import type { CreateProfileInput, LinearConfig, RunEvent, RunTranscriptItem, SchedulerSnapshot, SymphonyApi, Task } from "../shared/types.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: SymphonyApi = {
  profiles: {
    list: () => invoke("profiles:list"),
    create: (input: CreateProfileInput) => invoke("profiles:create", input),
    startLogin: (profileId: string) => invoke("profiles:startLogin", profileId),
    checkHealth: (profileId: string) => invoke("profiles:checkHealth", profileId),
    accountStatus: (profileId: string) => invoke("profiles:accountStatus", profileId)
  },
  linear: {
    getConfig: () => invoke("linear:getConfig"),
    saveConfig: (config: LinearConfig) => invoke("linear:saveConfig", config),
    testConnection: (config?: LinearConfig) => invoke("linear:testConnection", config),
    listIssues: (config?: LinearConfig) => invoke("linear:listIssues", config),
    syncNow: () => invoke("linear:syncNow"),
    transitionIssue: (issueId: string, stateName: string) => invoke("linear:transitionIssue", issueId, stateName),
    addComment: (issueId: string, body: string) => invoke("linear:addComment", issueId, body)
  },
  workflow: {
    snapshot: () => invoke("workflow:snapshot"),
    validate: () => invoke("workflow:validate")
  },
  scheduler: {
    start: () => invoke("scheduler:start"),
    stop: () => invoke("scheduler:stop"),
    tick: () => invoke("scheduler:tick"),
    snapshot: () => invoke("scheduler:snapshot")
  },
  tasks: {
    list: () => invoke("tasks:list"),
    enqueueFromLinear: (task: Task) => invoke("tasks:enqueueFromLinear", task),
    archive: (taskId: string) => invoke("tasks:archive", taskId)
  },
  runs: {
    list: () => invoke("runs:list"),
    start: (taskId: string, profileId: string) => invoke("runs:start", taskId, profileId),
    cancel: (runId: string) => invoke("runs:cancel", runId),
    retry: (runId: string) => invoke("runs:retry", runId),
    getEvents: (runId: string) => invoke("runs:getEvents", runId),
    getTranscript: (runId: string) => invoke("runs:getTranscript", runId),
    listApprovals: (runId?: string) => invoke("runs:listApprovals", runId),
    respondToApproval: (requestId: string, approved: boolean) => invoke("runs:respondToApproval", requestId, approved)
  },
  logs: {
    tail: (runId: string) => invoke("logs:tail", runId),
    export: (runId: string) => invoke("logs:export", runId)
  },
  health: {
    checkAll: () => invoke("health:checkAll")
  },
  events: {
    onRunEvent: (callback: (event: RunEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: RunEvent) => callback(value);
      ipcRenderer.on("events:runEvent", listener);
      return () => ipcRenderer.removeListener("events:runEvent", listener);
    },
    onTranscriptItem: (callback: (item: RunTranscriptItem) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: RunTranscriptItem) => callback(value);
      ipcRenderer.on("events:transcriptItem", listener);
      return () => ipcRenderer.removeListener("events:transcriptItem", listener);
    },
    onScheduler: (callback: (snapshot: SchedulerSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: SchedulerSnapshot) => callback(value);
      ipcRenderer.on("events:scheduler", listener);
      return () => ipcRenderer.removeListener("events:scheduler", listener);
    }
  }
};

contextBridge.exposeInMainWorld("symphony", api);

