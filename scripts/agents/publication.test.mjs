import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { branchName, snapshot } from "./policy.mjs";
import { marker } from "./github.mjs";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));

function fixture(
  t,
  { drift = false, base = "main", wrongDigest = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "codex-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  mkdirSync(work);
  mkdirSync(bin);
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: work,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);
  writeFileSync(join(work, "app.txt"), "Before\n");
  git("add", ".");
  git("commit", "-m", "Base");
  const sha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(work, "app.txt"), "After\n");
  writeFileSync(join(work, "asset.bin"), Buffer.from([0, 255, 1, 0, 128]));
  git("add", ".");
  const patch = git("diff", "--cached", "--binary", "--full-index", "HEAD");
  const patchPath = join(root, "implementation.patch");
  writeFileSync(patchPath, patch);
  git("reset", "--hard", "HEAD");
  const issue = {
    number: 42,
    title: "Implement tours",
    body: base === "main" ? "Requirements" : `Base branch: ${base}`,
    state: "OPEN",
    labels: ["ready-for-agent"],
    assignees: ["zrm20"],
    blockers: [],
    linkedPrs: [],
    url: "https://github.com/o/r/issues/42",
  };
  const claim = {
    repository: "o/r",
    issue: 42,
    issueUrl: issue.url,
    assignee: "zrm20",
    runId: "123",
    runAttempt: "1",
    runUrl: "https://github.com/o/r/actions/runs/123/attempts/1",
    branch: branchName(issue, "123", "1"),
    base,
    status: "running",
    snapshot: snapshot(issue),
    commentId: 100,
  };
  const fixturePath = join(root, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({ issue, claim, sha, drift, marker }),
  );
  const logPath = join(root, "requests.jsonl");
  writeFileSync(logPath, "");
  const fakeGh = join(bin, "gh");
  writeFileSync(
    fakeGh,
    `#!${process.execPath}
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE_PATH, 'utf8'));
const route = process.argv[3].split('?')[0];
const method = process.argv[process.argv.indexOf('--method') + 1];
const body = process.argv.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ route, method, body }) + '\\n');
let result;
if (route === 'graphql') {
  const field = body.query.includes('closedByPullRequestsReferences') ? 'closedByPullRequestsReferences' : 'blockedBy';
  result = { data: { repository: { issue: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
} else if (route.endsWith('/issues/42')) {
  result = { number: 42, title: fixture.issue.title, body: fixture.drift ? 'Changed requirements' : fixture.issue.body,
    state: 'open', assignees: [{ login: 'zrm20' }], labels: [{ name: 'ready-for-agent' }], html_url: fixture.issue.url };
} else if (route.endsWith('/comments')) {
  result = [{ id: 100, user: { login: 'github-actions[bot]' }, body: fixture.marker + JSON.stringify(fixture.claim) + ' -->' }];
} else if (route.includes('/git/ref/heads/')) {
  result = { object: { sha: fixture.sha } };
} else if (route.endsWith('/pulls')) {
  result = method === 'GET' ? [] : { html_url: 'https://github.com/o/r/pull/43' };
} else if (route.includes('/statuses/')) {
  result = { state: 'success' };
} else { throw new Error('Unexpected API request: ' + route); }
process.stdout.write(JSON.stringify(result));
`,
  );
  chmodSync(fakeGh, 0o755);
  const reportPath = join(root, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      status: "complete",
      summary: "Implemented tours.",
      review_complete: true,
      unresolved_findings: 0,
      checks: [{ command: "npm run check", passed: true }],
    }),
  );
  const outputPath = join(root, "outputs");
  writeFileSync(outputPath, "");
  const run = () =>
    spawnSync(process.execPath, [runner, "publish"], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLAIM: JSON.stringify(claim),
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: outputPath,
        FIXTURE_PATH: fixturePath,
        REQUEST_LOG: logPath,
        PATCH_PATH: patchPath,
        REPORT_PATH: reportPath,
        PATCH_DIGEST: wrongDigest
          ? "0".repeat(64)
          : createHash("sha256").update(patch).digest("hex"),
      },
    });
  const requests = () =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    run,
    git,
    claim,
    requests,
    outputs: () => readFileSync(outputPath, "utf8"),
    remote,
  };
}

test("publication pushes the verified text and binary patch, records commit status, and opens the linked PR", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.outputs(), /outcome=success/);
  assert.equal(f.git("show", `${f.claim.branch}:app.txt`), "After\n");
  const binary = execFileSync("git", [
    "--git-dir",
    f.remote,
    "show",
    `${f.claim.branch}:asset.bin`,
  ]);
  assert.deepEqual(binary, Buffer.from([0, 255, 1, 0, 128]));
  const pr = f
    .requests()
    .find(
      (request) =>
        request.route.endsWith("/pulls") && request.method === "POST",
    );
  assert.equal(pr.body.base, "main");
  assert.equal(pr.body.draft, false);
  assert.match(pr.body.body, /Closes #42/);
  assert.ok(
    f
      .requests()
      .some(
        (request) =>
          request.body?.context === "Codex pre-publication verification",
      ),
  );
  assert.equal(
    f.requests().some((request) => request.route.includes("/dispatches")),
    false,
  );
});

test("publication holds changed issues without pushing or creating a PR", (t) => {
  const f = fixture(t, { drift: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.outputs(), /outcome=held/);
  assert.equal(
    f
      .requests()
      .some(
        (request) =>
          request.method === "POST" && request.route.endsWith("/pulls"),
      ),
    false,
  );
  assert.equal(
    f.git("ls-remote", "origin", `refs/heads/${f.claim.branch}`),
    "",
  );
});

test("a changed artifact cannot be published", (t) => {
  const f = fixture(t, { wrongDigest: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the verified artifact/);
  assert.equal(
    f.git("ls-remote", "origin", `refs/heads/${f.claim.branch}`),
    "",
  );
});

test("alternate-base PRs reference the issue without closing it", (t) => {
  const f = fixture(t, { base: "codex/parent" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const pr = f
    .requests()
    .find(
      (request) =>
        request.route.endsWith("/pulls") && request.method === "POST",
    );
  assert.equal(pr.body.base, "codex/parent");
  assert.doesNotMatch(pr.body.body, /Closes #42/);
  assert.match(pr.body.body, /codex-issue:o\/r#42/);
});
