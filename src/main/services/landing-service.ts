import type { AutomationPolicy, GitHubPrStatus, LandingDecision, Run } from "../../shared/types.js";
import { isoNow } from "./time.js";

export class LandingService {
  approve(run: Run, prStatus?: GitHubPrStatus, policy?: AutomationPolicy, reason?: string): LandingDecision {
    const blocked = policy?.requireApprovalForLanding === false ? undefined : reason;
    const ready = run.state === "review" && prStatus?.checksStatus !== "failed" && prStatus?.reviewStatus !== "failed";
    return {
      runId: run.id,
      approved: ready,
      ...(blocked ? { reason: blocked } : reason ? { reason } : {}),
      decidedAt: isoNow()
    };
  }

  canAutoMerge(policy: AutomationPolicy, status: GitHubPrStatus, decision: LandingDecision): boolean {
    return policy.autoMerge && policy.trustedEnvironment && decision.approved && status.checksStatus === "passed" && status.reviewStatus !== "failed";
  }
}
