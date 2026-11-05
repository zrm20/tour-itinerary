export const ASSIGNEE = "zrm20";
export const READY = "ready-for-agent";
export const STOP_LABELS = ["agent:failed", "agent:held"];

export function baseBranch(body = "") {
  const lines = body
    .split(/\r?\n/)
    .filter((line) => /^Base branch:/i.test(line.trim()));
  if (lines.length > 1) throw new Error("Specify only one Base branch: line.");
  const branch = lines.length
    ? lines[0].trim().slice("Base branch:".length).trim()
    : "main";
  // A deliberately narrow, literal branch-name contract. Never interpret shell or URLs.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch
      .split("/")
      .some((part) => part.endsWith(".lock") || part.endsWith("."))
  ) {
    throw new Error(
      "Base branch must name one existing branch in this repository.",
    );
  }
  return branch;
}

export function branchName(issue, runId, attempt) {
  const slug =
    issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 45) || "implementation";
  return `codex/issue-${issue.number}-${slug}-${runId}-${attempt}`;
}

export function eligibility(
  issue,
  { retry = false, previous = null, openPrs = [] } = {},
) {
  if (issue.state !== "OPEN") return "Issue is not open.";
  if (!issue.labels.includes(READY)) return "Issue is not ready-for-agent.";
  if (issue.blockers.some((item) => item.state === "OPEN"))
    return "Issue has an open blocker.";
  // The workflow only resolves native dependencies; fail closed on the documented fallback.
  if (/^Blocked by:/im.test(issue.body))
    return "Convert the Blocked by: fallback to native dependencies first.";
  if (openPrs.length) return "Issue already has an open implementation PR.";
  if (!retry && issue.linkedPrs?.some((pr) => pr.state === "CLOSED"))
    return "A closed, unmerged PR requires an explicit retry.";
  if (
    !retry &&
    (previous || STOP_LABELS.some((label) => issue.labels.includes(label)))
  ) {
    return "A previous attempt requires an explicit retry.";
  }
  if (
    issue.assignees.length &&
    !(
      retry &&
      previous?.assignee === ASSIGNEE &&
      issue.assignees.length === 1 &&
      issue.assignees[0] === ASSIGNEE
    )
  ) {
    return "Issue is assigned elsewhere.";
  }
  return null;
}

export function snapshot(issue) {
  return {
    title: issue.title,
    body: issue.body,
    state: issue.state,
    assignees: [...issue.assignees].sort(),
    ready: issue.labels.includes(READY),
    blockers: issue.blockers
      .map(({ id, state }) => ({ id, state }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function driftReason(issue, claim, openPrs) {
  if (JSON.stringify(snapshot(issue)) !== JSON.stringify(claim.snapshot))
    return "Issue changed since it was claimed.";
  if (openPrs.length)
    return "An implementation PR was opened while this attempt was running.";
  return null;
}

export function validateReport(report) {
  if (
    report.status !== "complete" ||
    report.review_complete !== true ||
    report.unresolved_findings !== 0 ||
    !Array.isArray(report.checks) ||
    !report.checks.length ||
    report.checks.some((check) => check.passed !== true || !check.command) ||
    typeof report.summary !== "string" ||
    !report.summary.trim()
  ) {
    throw new Error(
      "Agent did not report completed implementation, passing checks, and resolved code review.",
    );
  }
}
