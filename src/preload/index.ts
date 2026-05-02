import { contextBridge, ipcRenderer } from "electron";
import type { CreateProfileInput, LinearConfig, SymphonyApi, Task } from "../shared/types.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: SymphonyApi = {
  profiles: {
    list: () => invoke("profiles:list"),
    create: (input: CreateProfileInput) => invoke("profiles:create", input),
    startLogin: (profileId: string) => invoke("profiles:startLogin", profileId),
    checkHealth: (profileId: string) => invoke("profiles:checkHealth", profileId)
  },
  linear: {
    saveConfig: (config: LinearConfig) => invoke("linear:saveConfig", config),
    testConnection: (config?: LinearConfig) => invoke("linear:testConnection", config),
    listIssues: (config?: LinearConfig) => invoke("linear:listIssues", config),
    syncNow: () => invoke("linear:syncNow")
  },
  tasks: {
    list: () => invoke("tasks:list"),
    enqueueFromLinear: (task: Task) => invoke("tasks:enqueueFromLinear", task),
    archive: (taskId: string) => invoke("tasks:archive", taskId)
  },
  runs: {
    start: (taskId: string, profileId: string) => invoke("runs:start", taskId, profileId),
    cancel: (runId: string) => invoke("runs:cancel", runId),
    retry: (runId: string) => invoke("runs:retry", runId),
    getEvents: (runId: string) => invoke("runs:getEvents", runId),
    listApprovals: (runId?: string) => invoke("runs:listApprovals", runId),
    listPendingApprovals: () => invoke("runs:listPendingApprovals"),
    respondToApproval: (requestId: string, approved: boolean) => invoke("runs:respondToApproval", requestId, approved)
  },
  orchestrator: {
    snapshot: () => invoke("orchestrator:snapshot"),
    start: () => invoke("orchestrator:start"),
    pause: () => invoke("orchestrator:pause"),
    resume: () => invoke("orchestrator:resume"),
    tick: () => invoke("orchestrator:tick"),
    updatePolicy: (policy) => invoke("orchestrator:updatePolicy", policy)
  },
  logs: {
    tail: (runId: string) => invoke("logs:tail", runId),
    export: (runId: string) => invoke("logs:export", runId)
  },
  health: {
    checkAll: () => invoke("health:checkAll")
  }
};

contextBridge.exposeInMainWorld("symphony", api);

