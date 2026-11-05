import assert from "node:assert/strict";
import test from "node:test";
import { Automation } from "./automation.mjs";
import { marker } from "./github.mjs";

function harness() {
  const issues = new Map(
    [1, 2, 3].map((number) => [
      number,
      {
        number,
        title: `Issue ${number}`,
        body: "Requirements",
        state: "OPEN",
        labels: ["ready-for-agent"],
        assignees: [],
        blockers: [],
        linkedPrs: [],
        url: `https://github.com/o/r/issues/${number}`,
      },
    ]),
  );
  const claims = new Map();
  const calls = [];
  const prs = [];
  let failAssignment = false;
  const client = {
    loadIssue: (_, number) => structuredClone(issues.get(number)),
    latestClaim: (_, number) => structuredClone(claims.get(number) || null),
    openImplementationPrs: () => [...prs],
    pages: (route) => (route.includes("/labels") ? [] : [...issues.values()]),
    api(route, method, body) {
      calls.push({ route, method, body });
      const number = Number(route.match(/issues\/(\d+)/)?.[1]);
      if (route.endsWith("/comments") && body.body.startsWith(marker)) {
        const record = JSON.parse(
          body.body.slice(marker.length, body.body.indexOf(" -->")),
        );
        claims.set(number, { ...record, commentId: number + 100 });
        return { id: number + 100 };
      }
      if (route.endsWith("/assignees")) {
        if (failAssignment) throw new Error("Assignment API unavailable");
        issues.get(number).assignees.push(...body.assignees);
      }
      if (route.includes("/git/ref/heads/"))
        return { object: { sha: "a".repeat(40) } };
      if (route.includes("/issues/comments/") && method === "PATCH") {
        const record = JSON.parse(
          body.body.slice(marker.length, body.body.indexOf(" -->")),
        );
        claims.set(record.issue, { ...record, commentId: record.issue + 100 });
      }
      return null;
    },
  };
  const automation = new Automation(
    { repository: "o/r", runId: "123", runAttempt: "1" },
    client,
  );
  return {
    automation,
    issues,
    claims,
    calls,
    prs,
    breakAssignment: () => {
      failAssignment = true;
    },
  };
}

test("scan skips blocked and manually assigned tickets, claims only the first eligible ticket", () => {
  const h = harness();
  h.issues.get(1).blockers = [{ id: "x", state: "OPEN" }];
  h.issues.get(2).assignees = ["zrm20"];
  let persisted;
  const claim = h.automation.claim({
    onClaim: (value) => {
      persisted = structuredClone(value);
    },
  });
  assert.equal(claim.issue, 3);
  assert.deepEqual(h.issues.get(3).assignees, ["zrm20"]);
  assert.deepEqual(persisted.snapshot.assignees, ["zrm20"]);
  assert.equal(h.claims.size, 1);
  assert.equal(h.automation.guard(claim).safe, true);
});

test("claim is persisted before assignment failure so the finalizer can report it", () => {
  const h = harness();
  h.breakAssignment();
  let persisted;
  assert.throws(
    () =>
      h.automation.claim({
        number: 1,
        onClaim: (claim) => {
          persisted = claim;
        },
      }),
    /Assignment/,
  );
  assert.equal(persisted.issue, 1);
  h.automation.finish(persisted, "failed", "Assignment failed.");
  assert.equal(h.claims.get(1).status, "failed");
  assert.ok(
    h.calls.some((call) => call.body?.labels?.includes("agent:failed")),
  );
});

test("automatic rescans do not retry previous attempts; explicit retry replaces the claim", () => {
  const h = harness();
  const first = h.automation.claim({ number: 1 });
  h.automation.finish(first, "failed", "Tests failed.");
  assert.throws(() => h.automation.claim({ number: 1 }), /explicit retry/);
  const retryAutomation = new Automation(
    { repository: "o/r", runId: "124", runAttempt: "1" },
    {
      ...h.automation.client,
      api(route, method, body) {
        // GitHub addAssignees is idempotent for the same user.
        if (route.endsWith("/assignees")) h.issues.get(1).assignees = [];
        return h.automation.client.api(route, method, body);
      },
    },
  );
  const next = retryAutomation.claim({ number: 1, retry: true });
  assert.notEqual(first.branch, next.branch);
  assert.equal(h.automation.guard(first).safe, false);
  assert.equal(retryAutomation.guard(next).safe, true);
});

test("publication is held after ownership, requirements, blockers, claim, or PR changes", () => {
  for (const change of [
    (h) => {
      h.issues.get(1).assignees = ["another"];
    },
    (h) => {
      h.issues.get(1).body = "Different requirements";
    },
    (h) => {
      h.issues.get(1).blockers = [{ id: "new", state: "OPEN" }];
    },
    (h) => {
      h.claims.get(1).runId = "999";
    },
    (h) => {
      h.prs.push({ url: "human PR" });
    },
  ]) {
    const h = harness();
    const claim = h.automation.claim({ number: 1 });
    change(h);
    assert.equal(h.automation.guard(claim).safe, false);
  }
});

test("failure and hold labels are supplemental; completion never changes readiness or assignment", () => {
  for (const status of ["failed", "held", "success"]) {
    const h = harness();
    const claim = h.automation.claim({ number: 1 });
    h.automation.finish(claim, status, "Result details");
    assert.equal(h.claims.get(1).status, status);
    assert.deepEqual(h.issues.get(1).assignees, ["zrm20"]);
    assert.deepEqual(h.issues.get(1).labels, ["ready-for-agent"]);
    assert.equal(h.calls.filter((call) => call.method === "DELETE").length, 0);
    assert.equal(
      h.calls.some((call) => call.body?.labels?.includes(`agent:${status}`)),
      status !== "success",
    );
    assert.ok(
      h.calls.some((call) => call.body?.body?.includes("Result details")),
    );
  }
});

test("invalid overrides are recorded and reported as failures instead of silently using main", () => {
  const h = harness();
  h.issues.get(1).body = "Base branch: missing branch with spaces";
  const claim = h.automation.claim({ number: 1 });
  assert.equal(claim.base, null);
  assert.throws(() => h.automation.guard(claim), /Base branch/);
  h.automation.finish(claim, "failed", claim.baseError);
  assert.equal(h.claims.get(1).status, "failed");
});

test("drift during claiming reaches preflight as held rather than failing assignment", () => {
  const h = harness();
  const client = h.automation.client;
  const automation = new Automation(
    { repository: "o/r", runId: "123", runAttempt: "1" },
    {
      ...client,
      api(route, method, body) {
        const result = client.api(route, method, body);
        if (route.endsWith("/assignees"))
          h.issues.get(1).body = "Edited during assignment";
        return result;
      },
    },
  );
  const claim = automation.claim({ number: 1 });
  assert.equal(automation.guard(claim).safe, false);
  automation.finish(claim, "held", "Issue changed during claiming.");
  assert.equal(h.claims.get(1).status, "held");
});
