import assert from "node:assert/strict";
import test from "node:test";
import {
  baseBranch,
  branchName,
  eligibility,
  snapshot,
  driftReason,
} from "./gate.mjs";
import { claimIssue, recheck, recover, marker } from "./gate.mjs";

const issue = () => ({
  number: 42,
  title: "Add tour members",
  body: "Implement memberships.",
  state: "OPEN",
  labels: ["ready-for-agent"],
  assignees: [],
  blockers: [],
  linkedPrs: [],
});

test("eligibility requires an open, ready, unassigned issue without open blockers or PRs", () => {
  assert.equal(eligibility(issue()), null);
  for (const change of [
    { state: "CLOSED" },
    { labels: [] },
    { assignees: ["zrm20"] },
    { assignees: ["someone-else"] },
    { blockers: [{ id: "x", state: "OPEN" }] },
    { body: "Blocked by: #1" },
    { labels: ["ready-for-agent", "agent:failed"] },
    { labels: ["ready-for-agent", "agent:held"] },
    { linkedPrs: [{ state: "CLOSED", url: "closed-human-pr" }] },
  ])
    assert.ok(eligibility({ ...issue(), ...change }), JSON.stringify(change));
  assert.ok(eligibility(issue(), { openPrs: [{ url: "human-pr" }] }));
  assert.equal(
    eligibility({ ...issue(), blockers: [{ id: "x", state: "CLOSED" }] }),
    null,
  );
});

test("retry bypasses only its own assignment and prior-attempt stop conditions", () => {
  const previous = { assignee: "zrm20" };
  const assigned = {
    ...issue(),
    assignees: ["zrm20"],
    labels: ["ready-for-agent", "agent:failed"],
  };
  assert.equal(eligibility(assigned, { retry: true, previous }), null);
  assert.ok(eligibility(assigned, { retry: true }));
  assert.ok(eligibility(assigned, { previous }));
  assert.ok(
    eligibility(
      { ...assigned, assignees: ["zrm20", "another"] },
      { retry: true, previous },
    ),
  );
  for (const change of [
    { state: "CLOSED" },
    { labels: [] },
    { blockers: [{ state: "OPEN" }] },
  ]) {
    assert.ok(
      eligibility({ ...assigned, ...change }, { retry: true, previous }),
    );
  }
  assert.ok(eligibility(assigned, { retry: true, previous, openPrs: [{}] }));
  assert.equal(
    eligibility(
      { ...issue(), linkedPrs: [{ state: "CLOSED" }] },
      { retry: true },
    ),
    null,
  );
});

test("base override is a single literal local branch name", () => {
  assert.equal(baseBranch("Nothing special."), "main");
  assert.equal(
    baseBranch("Task\nBase branch: codex/parent-42\nDetails"),
    "codex/parent-42",
  );
  for (const body of [
    "Base branch: x\nBase branch: y",
    "Base branch: https://github.com/a/b",
    "Base branch: owner:branch",
    "Base branch: x $(touch nope)",
    "Base branch: ../x",
    "Base branch: x.lock",
    "Base branch:",
    "Base branch: x//y",
  ]) {
    assert.throws(() => baseBranch(body), body);
  }
});

test("branches include issue identity and a distinct attempt identity", () => {
  assert.equal(
    branchName(issue(), "123", "1"),
    "codex/issue-42-add-tour-members-123-1",
  );
  assert.notEqual(
    branchName(issue(), "123", "1"),
    branchName(issue(), "123", "2"),
  );
  assert.match(
    branchName({ ...issue(), title: "`$(untrusted)` / 你好" }, "123", "1"),
    /^codex\/issue-42-[a-z0-9-]+$/,
  );
});

test("drift compares requirements, state, ownership, readiness and all blocker identities", () => {
  const original = { ...issue(), assignees: ["zrm20"] };
  const claim = { snapshot: snapshot(original) };
  assert.equal(driftReason(original, claim, []), null);
  assert.equal(
    driftReason(
      { ...original, labels: [...original.labels, "agent:failed"] },
      claim,
      [],
    ),
    null,
  );
  for (const change of [
    { title: "New title" },
    { body: "New requirements" },
    { state: "CLOSED" },
    { labels: [] },
    { assignees: [] },
    { blockers: [{ id: "closed-blocker", state: "CLOSED" }] },
  ]) {
    assert.ok(
      driftReason({ ...original, ...change }, claim, []),
      JSON.stringify(change),
    );
  }
  assert.ok(driftReason(original, claim, [{ url: "new-human-pr" }]));
});

function fixture() {
  const current = { ...issue(), url: "https://github.com/o/r/issues/42" };
  const calls = [];
  const prs = [];
  let previous = null;
  let assignmentFails = false;
  const client = {
    loadIssue: () => structuredClone(current),
    latestClaim: () => previous,
    openImplementationPrs: () => prs.map((pr) => ({ url: pr.html_url })),
    pages: (route) =>
      route.includes("/pulls?")
        ? prs
        : route.endsWith("/labels")
          ? []
          : [current],
    api(route, method, body) {
      calls.push({ route, method, body });
      if (route.endsWith("/comments") && body.body.startsWith(marker)) {
        previous = {
          ...JSON.parse(
            body.body.slice(marker.length, body.body.indexOf(" -->")),
          ),
          commentId: 100,
        };
        return { id: 100 };
      }
      if (route.endsWith("/assignees")) {
        if (assignmentFails) throw new Error("Assignment unavailable");
        current.assignees = [
          ...new Set([...current.assignees, ...body.assignees]),
        ];
      }
      if (route.includes("/git/ref/heads/"))
        return { object: { sha: "a".repeat(40) } };
      return null;
    },
  };
  const settings = { repository: "o/r", runId: "123", runAttempt: "1" };
  return {
    current,
    client,
    calls,
    prs,
    settings,
    breakAssignment: () => {
      assignmentFails = true;
    },
  };
}

test("claim records ownership before assignment, resolves the base, and stops automatic retries", () => {
  const h = fixture();
  let persisted;
  const result = claimIssue(h.settings, h.client, (claim) => {
    persisted = claim;
  });
  assert.equal(result.ready, true);
  assert.deepEqual(h.current.assignees, ["zrm20"]);
  assert.equal(result.claim, persisted);
  assert.equal(result.sha, "a".repeat(40));
  assert.equal(recheck(result.claim, h.client), null);
  assert.equal(claimIssue(h.settings, h.client), null);
  h.current.labels.push("agent:failed");
  const retry = claimIssue(
    { ...h.settings, runId: "124", number: 42, retry: true },
    h.client,
  );
  assert.notEqual(result.claim.branch, retry.claim.branch);
  assert.ok(
    h.calls.some(
      (call) =>
        call.method === "DELETE" && call.route.includes("agent%3Afailed"),
    ),
  );
});

test("partial assignment failures remain recoverable", () => {
  const h = fixture();
  h.breakAssignment();
  let persisted;
  assert.throws(
    () =>
      claimIssue(h.settings, h.client, (claim) => {
        persisted = claim;
      }),
    /Assignment unavailable/,
  );
  assert.equal(persisted.issue, 42);
  recover(persisted, "setup-failure", h.client);
  assert.ok(
    h.calls.some((call) => call.body?.labels?.includes("agent:failed")),
  );
});

test("recheck detects edited requirements and newly opened human PRs", () => {
  const h = fixture();
  const { claim } = claimIssue(h.settings, h.client);
  h.current.body = "Changed";
  assert.match(recheck(claim, h.client), /changed/);
  h.current.body = claim.snapshot.body;
  h.prs.push({ html_url: "https://github.com/o/r/pull/43" });
  assert.match(recheck(claim, h.client), /PR/);
});

test("recovery leaves normal agent outcomes alone and reports missing PRs or crashes", () => {
  for (const scenario of [
    "success",
    "missing-pr",
    "crash",
    "held",
    "reported",
  ]) {
    const h = fixture();
    const { claim } = claimIssue(h.settings, h.client);
    if (scenario === "success" || scenario === "crash")
      h.prs.push({
        html_url: "https://github.com/o/r/pull/43",
        head: { ref: claim.branch, repo: { full_name: "o/r" } },
      });
    if (scenario === "held") h.current.body = "Edited during work";
    if (scenario === "reported") h.current.labels.push("agent:failed");
    const count = h.calls.length;
    recover(claim, scenario === "crash" ? "failure" : "success", h.client);
    const writes = h.calls.slice(count);
    if (scenario === "success" || scenario === "reported")
      assert.equal(writes.length, 0);
    else
      assert.ok(
        writes.some((call) =>
          call.body?.labels?.includes(
            scenario === "held" ? "agent:held" : "agent:failed",
          ),
        ),
      );
  }
});
