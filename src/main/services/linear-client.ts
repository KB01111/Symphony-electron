import type { HealthCheckResult, LinearConfig, Task } from "../../shared/types.js";
import { isoNow } from "./time.js";

type FetchLike = typeof fetch;

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  state?: { name?: string | null } | null;
  assignee?: { name?: string | null } | null;
  team?: { key?: string | null } | null;
  project?: { name?: string | null } | null;
  updatedAt: string;
}

interface LinearIssuesResponse {
  data?: {
    issues?: {
      nodes?: LinearIssueNode[];
    };
  };
  errors?: Array<{ message: string }>;
}

export class LinearClient {
  private readonly fetchImpl: FetchLike;

  constructor(options: { fetch?: FetchLike } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listIssues(config: LinearConfig): Promise<Task[]> {
    const response = await this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: config.apiKey
      },
      body: JSON.stringify({
        query: `
          query SymphonyIssues($filter: IssueFilter) {
            issues(filter: $filter, first: 50, orderBy: updatedAt) {
              nodes {
                id identifier title description url priority updatedAt
                state { name }
                assignee { name }
                team { key }
                project { name }
              }
            }
          }
        `,
        variables: {
          filter: {
            ...(config.teamKey ? { team: { key: { eq: config.teamKey } } } : {}),
            state: { name: { in: config.activeStateNames } }
          }
        }
      })
    });

    const payload = (await response.json()) as LinearIssuesResponse;
    if (!response.ok || payload.errors?.length) {
      const detail = payload.errors?.map((error) => error.message).join("; ") || `${response.status} ${response.statusText}`;
      throw new Error(`Linear request failed: ${detail}`);
    }

    return (payload.data?.issues?.nodes ?? []).map((node) => {
      const task: Task = {
        id: `linear:${node.id}`,
        externalId: node.id,
        source: "linear",
        identifier: node.identifier,
        title: node.title,
        description: node.description ?? "",
        status: node.state?.name ?? "Unknown",
        priority: node.priority ?? 0,
        updatedAt: node.updatedAt,
        ...(node.url ? { url: node.url } : {}),
        ...(node.assignee?.name ? { assignee: node.assignee.name } : {}),
        ...(node.team?.key ? { teamKey: node.team.key } : {}),
        ...(node.project?.name ? { projectName: node.project.name } : {})
      };
      return task;
    });
  }

  async testConnection(config: LinearConfig): Promise<HealthCheckResult> {
    try {
      await this.listIssues({ ...config, activeStateNames: config.activeStateNames.slice(0, 1) });
      return {
        ok: true,
        label: "Linear",
        detail: "Linear API accepted the configured token.",
        checkedAt: isoNow()
      };
    } catch (error) {
      return {
        ok: false,
        label: "Linear",
        detail: (error as Error).message,
        checkedAt: isoNow()
      };
    }
  }
}
