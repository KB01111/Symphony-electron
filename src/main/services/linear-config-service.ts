import path from "node:path";
import type { LinearConfig } from "../../shared/types.js";
import { FileStateStore } from "./file-state.js";

const defaultConfig: LinearConfig = {
  apiKey: "",
  activeStateNames: ["Ready", "Todo", "In Progress"],
  pollIntervalSeconds: 60
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
    const normalized: LinearConfig = {
      apiKey: config.apiKey.trim(),
      activeStateNames: config.activeStateNames.map((state) => state.trim()).filter(Boolean),
      pollIntervalSeconds: Math.max(15, Number(config.pollIntervalSeconds) || 60),
      ...(teamKey ? { teamKey } : {})
    };
    await this.store.write(normalized);
    return normalized;
  }
}
