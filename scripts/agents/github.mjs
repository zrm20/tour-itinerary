import { execFileSync } from "node:child_process";

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
