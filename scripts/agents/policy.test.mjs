import assert from "node:assert/strict";
import test from "node:test";
import {
  baseBranch,
  branchName,
  eligibility,
  snapshot,
  driftReason,
  validateReport,
} from "./policy.mjs";

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

test("reports cannot pass with incomplete work, unrun checks, or unresolved review findings", () => {
  const complete = {
    status: "complete",
    review_complete: true,
    unresolved_findings: 0,
    summary: "Implemented and verified.",
    checks: [{ command: "npm run check", passed: true }],
  };
  assert.doesNotThrow(() => validateReport(complete));
  for (const change of [
    { status: "blocked" },
    { status: "failed" },
    { review_complete: false },
    { unresolved_findings: 1 },
    { checks: [] },
    { checks: [{ command: "npm test", passed: false }] },
    { summary: "" },
  ]) {
    assert.throws(() => validateReport({ ...complete, ...change }));
  }
});
