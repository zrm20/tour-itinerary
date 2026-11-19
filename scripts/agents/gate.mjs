import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function api(route, method = "GET", body) {
  const args = ["api", route, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : null;
}

export function pages(route) {
  const result = [];
  for (let page = 1; ; page++) {
    const values = api(
      `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(values))
      throw new Error(`Expected paginated array: ${route}`);
    result.push(...values);
    if (values.length < 100) return result;
  }
}

export function loadIssue(repository, number) {
  const [owner, name] = repository.split("/");
  const issue = api(`repos/${repository}/issues/${number}`);
  if (issue.pull_request)
    throw new Error("The requested ticket is a PR, not an issue.");
  const connections = {};
  const selections = {
    blockedBy: "id state",
    closedByPullRequestsReferences: "url state",
  };
  for (const [field, selection] of Object.entries(selections)) {
    const nodes = [];
    let after = null;
    do {
      const extra =
        field === "closedByPullRequestsReferences"
          ? ", includeClosedPrs: true"
          : "";
      const result = api("graphql", "POST", {
        query: `query($owner:String!,$name:String!,$number:Int!,$after:String) {
          repository(owner:$owner,name:$name) { issue(number:$number) {
            ${field}(first:100,after:$after${extra}) {
              nodes { ${selection} } pageInfo { hasNextPage endCursor }
            }
          } }
        }`,
        variables: { owner, name, number, after },
      });
      if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
      const connection = result.data?.repository?.issue?.[field];
      if (!connection?.nodes || !connection.pageInfo)
        throw new Error(`Cannot read ${field}; refusing pickup.`);
      nodes.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
      if (connection.pageInfo.hasNextPage && !after)
        throw new Error("Missing pagination cursor.");
    } while (after);
    connections[field] = nodes;
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    url: issue.html_url,
    state: issue.state.toUpperCase(),
    assignees: issue.assignees.map((user) => user.login),
    labels: issue.labels.map((label) => label.name),
    blockers: connections.blockedBy,
    linkedPrs: connections.closedByPullRequestsReferences,
  };
}

export const marker = "<!-- codex-implementation-claim ";

export function latestClaim(repository, number) {
  const comments = pages(`repos/${repository}/issues/${number}/comments`);
  for (const comment of comments.reverse()) {
    if (
      comment.user?.login !== "github-actions[bot]" ||
      !comment.body.startsWith(marker)
    )
      continue;
    const end = comment.body.indexOf(" -->");
    if (end < 0) continue;
    const claim = JSON.parse(comment.body.slice(marker.length, end));
    if (claim.repository === repository && claim.issue === number)
      return { ...claim, commentId: comment.id };
  }
  return null;
}

export function openImplementationPrs(repository, issue, claim) {
  const open = issue.linkedPrs.filter((pr) => pr.state === "OPEN");
  // Non-default-base PRs cannot use closing keywords. Track our own PRs explicitly, too.
  const tag = `<!-- codex-issue:${repository}#${issue.number} -->`;
  const prs = pages(`repos/${repository}/pulls?state=open`);
  for (const pr of prs) {
    if (
      pr.body?.includes(tag) ||
      (claim &&
        pr.head?.ref === claim.branch &&
        pr.head?.repo?.full_name === repository)
    ) {
      open.push({ url: pr.html_url, state: "OPEN" });
    }
  }
  return open;
}

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

// The only automation outside Codex: claim eligibility, recheck it, and recover interrupted runs.
export function gateClient() {
  return { api, pages, loadIssue, latestClaim, openImplementationPrs };
}

export function claimIssue(settings, client = gateClient(), save = () => {}) {
  const { repository, runId, runAttempt, number, retry = false } = settings;
  const root = `repos/${repository}`;
  const candidates = number
    ? [number]
    : client
        .pages(
          `${root}/issues?state=open&labels=${READY}&sort=created&direction=asc`,
        )
        .filter((issue) => !issue.pull_request)
        .map((issue) => issue.number);
  for (const candidate of candidates) {
    const issue = client.loadIssue(repository, candidate);
    const previous = client.latestClaim(repository, candidate);
    const prs = client.openImplementationPrs(repository, issue, previous);
    const reason = eligibility(issue, { retry, previous, openPrs: prs });
    if (reason) {
      if (number) throw new Error(reason);
      continue;
    }
    const claim = {
      repository,
      issue: issue.number,
      issueUrl: issue.url,
      assignee: ASSIGNEE,
      runId: String(runId),
      runAttempt: String(runAttempt),
      runUrl: `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
      branch: branchName(issue, runId, runAttempt),
      snapshot: { ...snapshot(issue), assignees: [ASSIGNEE] },
    };
    const { snapshot: ignored, ...record } = claim;
    const comment = client.api(`${root}/issues/${candidate}/comments`, "POST", {
      body: `${marker}${JSON.stringify(record)} -->\nClaimed for @${ASSIGNEE}. [Run](${claim.runUrl}) · Branch: \`${claim.branch}\``,
    });
    claim.commentId = comment.id;
    save(claim); // Persist before assigning, so partial setup failures can be reported.
    client.api(`${root}/issues/${candidate}/assignees`, "POST", {
      assignees: [ASSIGNEE],
    });
    const current = client.loadIssue(repository, candidate);
    if (driftReason(current, claim, [])) return { claim, ready: false };
    for (const label of STOP_LABELS.filter((label) =>
      current.labels.includes(label),
    )) {
      client.api(
        `${root}/issues/${candidate}/labels/${encodeURIComponent(label)}`,
        "DELETE",
      );
    }
    const base = baseBranch(issue.body);
    const ref = client.api(`${root}/git/ref/heads/${base}`);
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha || ""))
      throw new Error("Base branch did not resolve to a commit.");
    return { claim, ready: true, sha: ref.object.sha, base };
  }
  return null;
}

export function recheck(claim, client = gateClient()) {
  const issue = client.loadIssue(claim.repository, claim.issue);
  const previous = client.latestClaim(claim.repository, claim.issue);
  if (
    !previous ||
    previous.runId !== claim.runId ||
    previous.runAttempt !== claim.runAttempt ||
    previous.commentId !== claim.commentId
  ) {
    return "Automation claim changed or disappeared.";
  }
  return driftReason(
    issue,
    claim,
    client.openImplementationPrs(claim.repository, issue, previous),
  );
}

export function recover(claim, outcome, client = gateClient()) {
  const root = `repos/${claim.repository}`;
  const issue = client.loadIssue(claim.repository, claim.issue);
  // Normal outcomes belong to the agent. Leave any reported failure/hold intact.
  if (STOP_LABELS.some((label) => issue.labels.includes(label))) return;
  const previous = client.latestClaim(claim.repository, claim.issue);
  if (
    !previous ||
    previous.runId !== claim.runId ||
    previous.runAttempt !== claim.runAttempt
  )
    throw new Error("A different run owns this claim.");
  const ownPrs = client
    .pages(`${root}/pulls?state=open`)
    .filter(
      (pr) =>
        pr.head?.ref === claim.branch &&
        pr.head?.repo?.full_name === claim.repository,
    );
  const others = client
    .openImplementationPrs(claim.repository, issue, previous)
    .filter((pr) => !ownPrs.some((own) => own.html_url === pr.url));
  const drift =
    outcome === "setup-failure" ? null : driftReason(issue, claim, others);
  if (outcome === "success" && ownPrs.length && !drift) return;
  const label = drift ? "agent:held" : "agent:failed";
  if (!client.pages(`${root}/labels`).some((item) => item.name === label)) {
    client.api(`${root}/labels`, "POST", {
      name: label,
      color: drift ? "fbca04" : "b60205",
    });
  }
  client.api(`${root}/issues/${claim.issue}/labels`, "POST", {
    labels: [label],
  });
  const explanation =
    drift ||
    (outcome === "success"
      ? "Codex exited without opening the implementation PR."
      : "The agent or its setup did not complete successfully.");
  client.api(`${root}/issues/${claim.issue}/comments`, "POST", {
    body: `${explanation}\n\n[Run and available work](${claim.runUrl}). Assignment is retained; retry explicitly after inspecting the result.${ownPrs.map((pr) => ` Existing PR: ${pr.html_url}.`).join("")}`,
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const env = process.env;
  const output = (name, value) =>
    appendFileSync(
      env.GITHUB_OUTPUT,
      `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    );
  switch (process.argv[2]) {
    case "claim": {
      if (env.OPENAI_KEY_PRESENT !== "true")
        throw new Error("Configure OPENAI_API_KEY first.");
      const number = env.ISSUE_NUMBER ? Number(env.ISSUE_NUMBER) : undefined;
      if (
        number !== undefined &&
        (!Number.isSafeInteger(number) || number <= 0)
      )
        throw new Error("Invalid issue number.");
      if (env.RETRY === "true" && !number)
        throw new Error("Retry must name one issue.");
      const result = claimIssue(
        {
          repository: env.GITHUB_REPOSITORY,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
          number,
          retry: env.RETRY === "true",
        },
        gateClient(),
        (claim) => {
          output("claim", claim);
          output("claimed", "true");
        },
      );
      if (result) {
        output("ready", String(result.ready));
        if (result.sha) output("sha", result.sha);
      }
      break;
    }
    case "check": {
      const reason = recheck(JSON.parse(env.CLAIM));
      if (reason) {
        process.stderr.write(reason + "\n");
        process.exitCode = 2;
      } else
        process.stdout.write(
          "Issue still matches the claim; publication is eligible.\n",
        );
      break;
    }
    case "recover":
      recover(JSON.parse(env.CLAIM), env.AGENT_OUTCOME);
      break;
    default:
      throw new Error("Expected claim, check, or recover.");
  }
}
