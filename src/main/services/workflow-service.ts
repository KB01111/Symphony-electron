import path from "node:path";
import { readFile } from "node:fs/promises";
import { Liquid } from "liquidjs";
import { parse } from "yaml";
import type { Task, WorkflowSnapshot, WorkflowValidation } from "../../shared/types.js";
import { isoNow } from "./time.js";

type RawMap = Record<string, unknown>;

export interface WorkflowConfig {
  tracker: {
    kind: "linear";
    endpoint: string;
    apiKey: string;
    projectSlug?: string;
    activeStateNames: string[];
    terminalStateNames: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
  };
  codex: {
    command: string;
    approvalPolicy?: unknown;
    threadSandbox?: unknown;
    turnSandboxPolicy?: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

export interface LoadedWorkflow {
  path: string;
  config: WorkflowConfig;
  promptTemplate: string;
  validation: WorkflowValidation;
}

const fallbackPrompt = [
  "# Symphony Task",
  "",
  "Identifier: {{ issue.identifier }}",
  "Title: {{ issue.title }}",
  "",
  "{{ issue.description }}",
  "",
  "Work inside this isolated workspace. Preserve unrelated changes. Report verification clearly."
].join("\n");

export class WorkflowService {
  private readonly liquid = new Liquid({ strictVariables: true, strictFilters: true });
  private lastGood: LoadedWorkflow | null = null;

  constructor(
    private readonly workflowPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async load(): Promise<LoadedWorkflow> {
    try {
      const raw = await readFile(this.workflowPath, "utf8");
      const parsed = parseWorkflowFile(raw);
      const normalized = normalizeWorkflowConfig(parsed.config, path.dirname(this.workflowPath), this.env);
      const loaded: LoadedWorkflow = {
        path: this.workflowPath,
        config: normalized.config,
        promptTemplate: parsed.promptTemplate || fallbackPrompt,
        validation: {
          ok: normalized.errors.length === 0,
          errors: normalized.errors,
          checkedAt: isoNow()
        }
      };
      if (loaded.validation.ok) {
        this.lastGood = loaded;
      }
      return loaded.validation.ok || !this.lastGood ? loaded : { ...this.lastGood, validation: loaded.validation };
    } catch (error) {
      const validation: WorkflowValidation = {
        ok: false,
        errors: [(error as Error).message],
        checkedAt: isoNow()
      };
      if (this.lastGood) {
        return { ...this.lastGood, validation };
      }
      return {
        path: this.workflowPath,
        config: defaultWorkflowConfig(path.dirname(this.workflowPath), this.env),
        promptTemplate: fallbackPrompt,
        validation
      };
    }
  }

  async snapshot(): Promise<WorkflowSnapshot> {
    const loaded = await this.load();
    return {
      path: loaded.path,
      validation: loaded.validation,
      pollIntervalSeconds: Math.round(loaded.config.polling.intervalMs / 1000),
      maxConcurrentRuns: loaded.config.agent.maxConcurrentAgents,
      activeStateNames: loaded.config.tracker.activeStateNames,
      terminalStateNames: loaded.config.tracker.terminalStateNames
    };
  }

  async validate(): Promise<WorkflowValidation> {
    return (await this.load()).validation;
  }

  async renderPrompt(task: Task, attempt?: number): Promise<string> {
    const loaded = await this.load();
    const template = this.liquid.parse(loaded.promptTemplate);
    return this.liquid.render(template, {
      issue: {
        ...task,
        labels: task.labels ?? [],
        blockers: task.blockers ?? []
      },
      identifier: task.identifier,
      title: task.title,
      description: task.description,
      url: task.url ?? "",
      task_id: task.id,
      attempt: attempt ?? null
    });
  }
}

function parseWorkflowFile(raw: string): { config: RawMap; promptTemplate: string } {
  if (!raw.startsWith("---")) {
    return { config: {}, promptTemplate: raw.trim() };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    throw new Error("workflow_parse_error: missing closing front matter marker");
  }
  const frontMatter = raw.slice(3, end).trim();
  const parsed = frontMatter ? parse(frontMatter) : {};
  if (parsed !== null && (!isRecord(parsed) || Array.isArray(parsed))) {
    throw new Error("workflow_front_matter_not_a_map");
  }
  return {
    config: (parsed ?? {}) as RawMap,
    promptTemplate: raw.slice(end + 4).trim()
  };
}

function normalizeWorkflowConfig(config: RawMap, baseDir: string, env: NodeJS.ProcessEnv): { config: WorkflowConfig; errors: string[] } {
  const errors: string[] = [];
  const defaults = defaultWorkflowConfig(baseDir, env);
  const trackerRaw = objectValue(config.tracker, "tracker", errors);
  const pollingRaw = objectValue(config.polling, "polling", errors);
  const workspaceRaw = objectValue(config.workspace, "workspace", errors);
  const hooksRaw = objectValue(config.hooks, "hooks", errors);
  const agentRaw = objectValue(config.agent, "agent", errors);
  const codexRaw = objectValue(config.codex, "codex", errors);

  const apiKeyRaw = stringValue(trackerRaw.api_key) || stringValue(trackerRaw.apiKey) || "$LINEAR_API_KEY";
  const apiKey = resolveEnvReference(apiKeyRaw, env);
  const workspaceRootRaw = stringValue(workspaceRaw.root) || defaults.workspace.root;
  const projectSlug = stringValue(trackerRaw.project_slug) || stringValue(trackerRaw.projectSlug);
  const hooks: WorkflowConfig["hooks"] = {
    timeoutMs: positiveInteger(hooksRaw.timeout_ms, defaults.hooks.timeoutMs)
  };
  const afterCreate = stringValue(hooksRaw.after_create);
  const beforeRun = stringValue(hooksRaw.before_run);
  const afterRun = stringValue(hooksRaw.after_run);
  const beforeRemove = stringValue(hooksRaw.before_remove);
  if (afterCreate) hooks.afterCreate = afterCreate;
  if (beforeRun) hooks.beforeRun = beforeRun;
  if (afterRun) hooks.afterRun = afterRun;
  if (beforeRemove) hooks.beforeRemove = beforeRemove;

  return {
    errors,
    config: {
      tracker: {
        kind: "linear",
        endpoint: stringValue(trackerRaw.endpoint) || defaults.tracker.endpoint,
        apiKey,
        ...(projectSlug ? { projectSlug } : {}),
        activeStateNames: stringArray(trackerRaw.active_states, defaults.tracker.activeStateNames),
        terminalStateNames: stringArray(trackerRaw.terminal_states, defaults.tracker.terminalStateNames)
      },
      polling: {
        intervalMs: positiveInteger(pollingRaw.interval_ms, defaults.polling.intervalMs)
      },
      workspace: {
        root: resolvePathValue(workspaceRootRaw, baseDir, env)
      },
      hooks,
      agent: {
        maxConcurrentAgents: positiveInteger(agentRaw.max_concurrent_agents, defaults.agent.maxConcurrentAgents),
        maxTurns: positiveInteger(agentRaw.max_turns, defaults.agent.maxTurns),
        maxRetryBackoffMs: positiveInteger(agentRaw.max_retry_backoff_ms, defaults.agent.maxRetryBackoffMs),
        maxConcurrentAgentsByState: positiveIntegerMap(agentRaw.max_concurrent_agents_by_state)
      },
      codex: {
        command: stringValue(codexRaw.command) || defaults.codex.command,
        approvalPolicy: codexRaw.approval_policy,
        threadSandbox: codexRaw.thread_sandbox,
        turnSandboxPolicy: codexRaw.turn_sandbox_policy,
        turnTimeoutMs: positiveInteger(codexRaw.turn_timeout_ms, defaults.codex.turnTimeoutMs),
        readTimeoutMs: positiveInteger(codexRaw.read_timeout_ms, defaults.codex.readTimeoutMs),
        stallTimeoutMs: positiveInteger(codexRaw.stall_timeout_ms, defaults.codex.stallTimeoutMs)
      }
    }
  };
}

function defaultWorkflowConfig(baseDir: string, env: NodeJS.ProcessEnv): WorkflowConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: env.LINEAR_API_KEY ?? "",
      activeStateNames: ["Todo", "In Progress", "Ready"],
      terminalStateNames: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
    },
    polling: {
      intervalMs: 30_000
    },
    workspace: {
      root: path.resolve(baseDir, "symphony_workspaces")
    },
    hooks: {
      timeoutMs: 60_000
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {}
    },
    codex: {
      command: "codex app-server",
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000
    }
  };
}

function objectValue(value: unknown, label: string, errors: string[]): RawMap {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Array.isArray(value)) {
    errors.push(`${label} must be a map.`);
    return {};
  }
  return value;
}

function isRecord(value: unknown): value is RawMap {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function positiveIntegerMap(value: unknown): Record<string, number> {
  if (!isRecord(value) || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([key, candidate]) => [key.toLowerCase(), positiveInteger(candidate, 0)] as const)
    .filter(([, candidate]) => candidate > 0);
  return Object.fromEntries(entries);
}

function resolveEnvReference(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("$")) return value;
  return env[value.slice(1)] ?? "";
}

function resolvePathValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolvedEnv = resolveEnvReference(value, env);
  const homeExpanded = resolvedEnv.replace(/^~(?=$|[\\/])/, env.USERPROFILE ?? env.HOME ?? "~");
  return path.isAbsolute(homeExpanded) ? path.normalize(homeExpanded) : path.resolve(baseDir, homeExpanded);
}
