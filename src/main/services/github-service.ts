import type { CreatePrInput, GitHubConfig, GitHubPrStatus, ProofStatus, Run, Task } from "../../shared/types.js";
import { isoNow } from "./time.js";

type FetchLike = typeof fetch;

interface GitHubPullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  merged?: boolean;
}

interface GitHubCheckRun {
  status?: string;
  conclusion?: string | null;
}

interface GitHubReview {
  state?: string;
}

export class GitHubService {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async createOrUpdatePr(config: GitHubConfig, input: CreatePrInput): Promise<{ url: string; number: number }> {
    const existing = await this.findOpenPr(config, input.head);
    if (existing) {
      await this.request(config, `/repos/${config.owner}/${config.repo}/pulls/${existing.number}`, {
        method: "PATCH",
        body: JSON.stringify({ title: input.title, body: input.body, base: input.base, draft: input.draft ?? false })
      });
      return { url: existing.html_url, number: existing.number };
    }
    const created = await this.request<GitHubPullRequest>(config, `/repos/${config.owner}/${config.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft ?? false })
    });
    return { url: created.html_url, number: created.number };
  }

  async status(run: Run, task: Task, config?: GitHubConfig): Promise<GitHubPrStatus> {
    const repositoryUrl = task.repositoryUrl;
    const branchName = task.branchName;
    if (config && branchName) {
      const pull = await this.findOpenPr(config, branchName);
      if (pull) {
        const [checksStatus, reviewStatus] = await Promise.all([this.checksStatus(config, branchName), this.reviewStatus(config, pull.number)]);
        return {
          runId: run.id,
          taskId: task.id,
          repositoryUrl: repositoryUrl ?? `https://github.com/${config.owner}/${config.repo}`,
          branchName,
          prUrl: pull.html_url,
          prNumber: pull.number,
          merged: pull.merged ?? false,
          checksStatus,
          reviewStatus,
          detail: `PR #${pull.number}: checks ${checksStatus}, reviews ${reviewStatus}.`,
          updatedAt: isoNow()
        };
      }
    }
    const prUrl = inferPullRequestUrl(task);
    return {
      runId: run.id,
      taskId: task.id,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(branchName ? { branchName } : {}),
      ...(prUrl ? { prUrl } : {}),
      checksStatus: "unknown",
      reviewStatus: "unknown",
      detail: prUrl ? "Pull request metadata is linked from proof or tracker metadata." : "No pull request is linked yet.",
      updatedAt: isoNow()
    };
  }

  async merge(config: GitHubConfig, prNumber: number): Promise<void> {
    await this.request(config, `/repos/${config.owner}/${config.repo}/pulls/${prNumber}/merge`, { method: "PUT", body: JSON.stringify({}) });
  }

  private async checksStatus(config: GitHubConfig, ref: string): Promise<ProofStatus> {
    const response = await this.request<{ check_runs?: GitHubCheckRun[] }>(config, `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(ref)}/check-runs`);
    const checks = response.check_runs ?? [];
    if (!checks.length) return "unknown";
    return aggregateProofStatus(
      checks.map((check) => {
        if (check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped") return "passed";
        if (check.status !== "completed") return "warning";
        return "failed";
      })
    );
  }

  private async reviewStatus(config: GitHubConfig, prNumber: number): Promise<ProofStatus> {
    const reviews = await this.request<GitHubReview[]>(config, `/repos/${config.owner}/${config.repo}/pulls/${prNumber}/reviews`);
    if (!reviews.length) return "unknown";
    if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return "failed";
    if (reviews.some((review) => review.state === "APPROVED")) return "passed";
    return "warning";
  }

  private async findOpenPr(config: GitHubConfig, head: string): Promise<GitHubPullRequest | undefined> {
    const pulls = await this.request<GitHubPullRequest[]>(config, `/repos/${config.owner}/${config.repo}/pulls?state=open&head=${encodeURIComponent(`${config.owner}:${head}`)}`);
    return pulls[0];
  }

  private async request<T = unknown>(config: GitHubConfig, path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = config.apiBaseUrl ?? "https://api.github.com";
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...init.headers
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function inferPullRequestUrl(task: Task): string | undefined {
  if (!task.description) return undefined;
  const match = task.description.match(/https?:\/\/\S+\/pull\/\d+/u);
  return match?.[0];
}

export function aggregateProofStatus(statuses: ProofStatus[]): ProofStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("warning")) return "warning";
  if (statuses.length && statuses.every((status) => status === "passed")) return "passed";
  return "unknown";
}
