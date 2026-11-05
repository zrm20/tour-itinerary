import * as github from "./github.mjs";
import {
  ASSIGNEE,
  READY,
  STOP_LABELS,
  baseBranch,
  branchName,
  snapshot,
  eligibility,
  driftReason,
} from "./policy.mjs";

export class Automation {
  constructor(
    { repository, runId, runAttempt, server = "https://github.com" },
    client = github,
  ) {
    this.client = client;
    this.repository = repository;
    this.root = `repos/${repository}`;
    this.runId = String(runId);
    this.runAttempt = String(runAttempt);
    this.runUrl = `${server}/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
  }

  inspect(number) {
    const issue = this.client.loadIssue(this.repository, number);
    const previous = this.client.latestClaim(this.repository, number);
    const prs = this.client.openImplementationPrs(
      this.repository,
      issue,
      previous,
    );
    return { issue, previous, prs };
  }

  claim({ number, retry = false, onClaim = () => {} } = {}) {
    const numbers = number
      ? [number]
      : this.client
          .pages(
            `${this.root}/issues?state=open&labels=${READY}&sort=created&direction=asc`,
          )
          .filter((item) => !item.pull_request)
          .map((item) => item.number);
    for (const candidate of numbers) {
      const { issue, previous, prs } = this.inspect(candidate);
      const reason = eligibility(issue, { retry, previous, openPrs: prs });
      if (reason) {
        if (number) throw new Error(reason);
        continue;
      }
      let base = null;
      let baseError = null;
      try {
        base = baseBranch(issue.body);
      } catch (error) {
        baseError = error.message;
      }
      const claim = {
        repository: this.repository,
        issue: issue.number,
        issueUrl: issue.url,
        assignee: ASSIGNEE,
        runId: this.runId,
        runAttempt: this.runAttempt,
        runUrl: this.runUrl,
        branch: branchName(issue, this.runId, this.runAttempt),
        base,
        baseError,
        status: "running",
        snapshot: { ...snapshot(issue), assignees: [ASSIGNEE] },
      };
      const comment = this.client.api(
        `${this.root}/issues/${issue.number}/comments`,
        "POST",
        {
          body: this.claimBody(claim),
        },
      );
      claim.commentId = comment.id;
      // Persist workflow outputs before the next mutation so a partial claim can be reported.
      onClaim(claim);
      this.client.api(`${this.root}/issues/${issue.number}/assignees`, "POST", {
        assignees: [ASSIGNEE],
      });
      const current = this.client.loadIssue(this.repository, issue.number);
      const changed = driftReason(current, claim, []);
      // Leave the successful claim available to preflight, which classifies drift as held.
      if (changed) return claim;
      for (const label of STOP_LABELS.filter((label) =>
        current.labels.includes(label),
      )) {
        this.client.api(
          `${this.root}/issues/${issue.number}/labels/${encodeURIComponent(label)}`,
          "DELETE",
        );
      }
      return claim;
    }
    return null;
  }

  claimBody(claim, message = "Implementation in progress.") {
    const { snapshot: ignored, commentId: ignoredId, ...record } = claim;
    return `${github.marker}${JSON.stringify(record)} -->\n${message}\n\nAssigned to @${ASSIGNEE}. [Run](${claim.runUrl}) · Branch: \`${claim.branch}\``;
  }

  guard(claim) {
    const { issue, previous, prs } = this.inspect(claim.issue);
    if (
      !previous ||
      previous.runId !== claim.runId ||
      previous.runAttempt !== claim.runAttempt ||
      previous.commentId !== claim.commentId ||
      previous.status !== "running"
    ) {
      return {
        safe: false,
        reason: "Automation claim changed or disappeared.",
      };
    }
    const reason = driftReason(issue, claim, prs);
    if (reason) return { safe: false, reason };
    if (claim.baseError || !claim.base)
      throw new Error(claim.baseError || "Missing base branch.");
    const ref = this.client.api(`${this.root}/git/ref/heads/${claim.base}`);
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha || ""))
      throw new Error("Base branch did not resolve to a commit.");
    return { safe: true, sha: ref.object.sha };
  }

  finish(claim, status, message) {
    if (!["success", "failed", "held"].includes(status))
      throw new Error("Invalid completion status.");
    const latest = this.client.latestClaim(this.repository, claim.issue);
    if (
      !latest ||
      latest.runId !== claim.runId ||
      latest.runAttempt !== claim.runAttempt
    ) {
      throw new Error("Cannot finish a different automation claim.");
    }
    if (status !== "success") {
      const label = `agent:${status}`;
      const labels = this.client.pages(`${this.root}/labels`);
      if (!labels.some((item) => item.name === label)) {
        this.client.api(`${this.root}/labels`, "POST", {
          name: label,
          color: status === "failed" ? "b60205" : "fbca04",
          description:
            "Agent attempt stopped; inspect the run and explicitly retry.",
        });
      }
      this.client.api(`${this.root}/issues/${claim.issue}/labels`, "POST", {
        labels: [label],
      });
    }
    this.client.api(`${this.root}/issues/${claim.issue}/comments`, "POST", {
      body: `Agent implementation **${status}**.\n\n${message}\n\n[Run and available artifacts](${claim.runUrl}). Assignment is retained; retries must be explicit.`,
    });
    this.client.api(
      `${this.root}/issues/comments/${claim.commentId}`,
      "PATCH",
      {
        body: this.claimBody({ ...claim, status }, `Implementation ${status}.`),
      },
    );
  }
}
