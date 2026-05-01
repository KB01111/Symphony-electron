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
  branchName?: string | null;
  createdAt?: string | null;
  state?: { name?: string | null } | null;
  assignee?: { name?: string | null } | null;
  team?: { key?: string | null } | null;
  project?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> | null } | null;
  relations?: {
    nodes?: Array<{
      type?: string | null;
      relatedIssue?: {
        id?: string | null;
        identifier?: string | null;
        state?: { name?: string | null } | null;
        createdAt?: string | null;
        updatedAt?: string | null;
      } | null;
    }> | null;
  } | null;
  updatedAt: string;
}

interface LinearIssuesResponse {
  data?: {
    issues?: {
      nodes?: LinearIssueNode[];
      pageInfo?: {
        hasNextPage?: boolean | null;
        endCursor?: string | null;
      } | null;
    };
  };
  errors?: Array<{ message: string }>;
}

interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string | null;
}

interface LinearWorkflowStatesResponse {
  data?: {
    workflowStates?: {
      nodes?: LinearWorkflowState[];
    };
  };
  errors?: Array<{ message: string }>;
}

interface LinearMutationResponse {
  data?: Record<string, { success?: boolean } | undefined>;
  errors?: Array<{ message: string }>;
}

export class LinearClient {
  private readonly fetchImpl: FetchLike;

  constructor(options: { fetch?: FetchLike } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listIssues(config: LinearConfig): Promise<Task[]> {
    const tasks: Task[] = [];
    let after: string | null = null;

    do {
      const payload: LinearIssuesResponse = await this.graphql(config, {
        query: `
          query SymphonyIssues($filter: IssueFilter, $after: String) {
            issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id identifier title description url priority branchName createdAt updatedAt
                state { name }
                assignee { name }
                team { key }
                project { name }
                labels { nodes { name } }
                relations {
                  nodes {
                    type
                    relatedIssue {
                      id identifier createdAt updatedAt
                      state { name }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          after,
          filter: {
            ...(config.teamKey ? { team: { key: { eq: config.teamKey } } } : {}),
            ...(config.projectName ? { project: { name: { eq: config.projectName } } } : {}),
            state: { name: { in: config.activeStateNames } }
          }
        }
      });

      const page = payload.data?.issues;
      tasks.push(...(page?.nodes ?? []).map((node) => this.normalizeIssue(node, config)));
      after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
    } while (after);

    return tasks;
  }

  async listWorkflowStates(config: LinearConfig, teamKey?: string): Promise<LinearWorkflowState[]> {
    const payload: LinearWorkflowStatesResponse = await this.graphql(config, {
      query: `
        query SymphonyWorkflowStates($filter: WorkflowStateFilter) {
          workflowStates(first: 100, filter: $filter) {
            nodes { id name type }
          }
        }
      `,
      variables: {
        filter: teamKey ? { team: { key: { eq: teamKey } } } : undefined
      }
    });
    return payload.data?.workflowStates?.nodes ?? [];
  }

  async addComment(config: LinearConfig, issueId: string, body: string): Promise<void> {
    await this.graphql<LinearMutationResponse>(config, {
      query: `
        mutation SymphonyComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }
      `,
      variables: { issueId, body }
    });
  }

  async transitionIssue(config: LinearConfig, issueId: string, stateName: string, teamKey?: string): Promise<void> {
    const state = (await this.listWorkflowStates(config, teamKey)).find((candidate) => candidate.name.toLowerCase() === stateName.toLowerCase());
    if (!state) {
      throw new Error(`Linear workflow state not found: ${stateName}`);
    }
    await this.graphql<LinearMutationResponse>(config, {
      query: `
        mutation SymphonyIssueUpdate($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) {
            success
          }
        }
      `,
      variables: { issueId, stateId: state.id }
    });
  }

  async graphql<T = unknown>(config: LinearConfig, body: { query: string; variables?: Record<string, unknown> }): Promise<T> {
    const response = await this.fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: config.apiKey
      },
      body: JSON.stringify(body)
    });

    const payload = (await response.json()) as { errors?: Array<{ message: string }> };
    if (!response.ok || payload.errors?.length) {
      const detail = payload.errors?.map((error) => error.message).join("; ") || `${response.status} ${response.statusText}`;
      throw new Error(`Linear request failed: ${detail}`);
    }
    return payload as T;
  }

  async testConnection(config: LinearConfig): Promise<HealthCheckResult> {
    try {
      await this.graphql(config, {
        query: "query SymphonyViewer { viewer { id name } }"
      });
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

  private normalizeIssue(node: LinearIssueNode, config: LinearConfig): Task {
    const blockers = (node.relations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks" || relation.type === "blocked")
      .map((relation) => relation.relatedIssue)
      .filter((relatedIssue): relatedIssue is NonNullable<typeof relatedIssue> => Boolean(relatedIssue))
      .map((relatedIssue) => ({
        ...(relatedIssue.id ? { id: relatedIssue.id } : {}),
        ...(relatedIssue.identifier ? { identifier: relatedIssue.identifier } : {}),
        ...(relatedIssue.state?.name ? { state: relatedIssue.state.name } : {}),
        ...(relatedIssue.createdAt ? { createdAt: relatedIssue.createdAt } : {}),
        ...(relatedIssue.updatedAt ? { updatedAt: relatedIssue.updatedAt } : {})
      }));
    const task: Task = {
      id: `linear:${node.id}`,
      externalId: node.id,
      source: "linear",
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? "",
      status: node.state?.name ?? "Unknown",
      priority: node.priority ?? 0,
      labels: (node.labels?.nodes ?? []).map((label) => label.name?.trim().toLowerCase()).filter((label): label is string => Boolean(label)),
      blockers,
      updatedAt: node.updatedAt,
      ...(node.url ? { url: node.url } : {}),
      ...(node.assignee?.name ? { assignee: node.assignee.name } : {}),
      ...(node.team?.key ? { teamKey: node.team.key } : {}),
      ...(node.project?.name ? { projectName: node.project.name } : {}),
      ...(node.branchName ? { branchName: node.branchName } : {}),
      ...(node.createdAt ? { createdAt: node.createdAt } : {}),
      ...(config.repositoryUrl ? { repositoryUrl: config.repositoryUrl } : {})
    };
    return task;
  }
}
