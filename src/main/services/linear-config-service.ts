import path from "node:path";
import type { LinearConfig } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";

const defaultConfig: LinearConfig = {
  apiKey: "",
  activeStateNames: ["Ready", "Todo", "In Progress"],
  terminalStateNames: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  inProgressStateName: "In Progress",
  humanReviewStateName: "Human Review",
  pollIntervalSeconds: 60,
  maxConcurrentRuns: 2
};

export class LinearConfigService {
  private readonly store: FileStateStore<LinearConfig>;

  constructor(appDataRoot: string) {
    this.store = new FileStateStore<LinearConfig>(path.join(appDataRoot, "state", "linear-config.json"), defaultConfig);
  }

  async get(): Promise<LinearConfig> {
    return this.store.read();
  }

  async save(config: LinearConfig): Promise<LinearConfig> {
    const teamKey = config.teamKey?.trim();
    const projectSlug = config.projectSlug?.trim();
    const projectName = config.projectName?.trim();
    const repositoryUrl = config.repositoryUrl?.trim();
    const normalized: LinearConfig = {
      apiKey: config.apiKey.trim(),
      activeStateNames: config.activeStateNames.map((state) => state.trim()).filter(Boolean),
      terminalStateNames: (config.terminalStateNames ?? defaultConfig.terminalStateNames ?? []).map((state) => state.trim()).filter(Boolean),
      inProgressStateName: config.inProgressStateName?.trim() || "In Progress",
      humanReviewStateName: config.humanReviewStateName?.trim() || "Human Review",
      pollIntervalSeconds: Math.max(15, Number(config.pollIntervalSeconds) || 60),
      maxConcurrentRuns: Math.max(1, Number(config.maxConcurrentRuns) || 2),
      ...(projectSlug ? { projectSlug } : {}),
      ...(projectName ? { projectName } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(teamKey ? { teamKey } : {})
    };
    await this.store.write(normalized);
    return normalized;
  }
}
