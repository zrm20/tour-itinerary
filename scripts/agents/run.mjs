import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Automation } from "./automation.mjs";
import { api } from "./github.mjs";
import { validateReport } from "./policy.mjs";

const env = process.env;
const automation = new Automation({
  repository: env.GITHUB_REPOSITORY,
  runId: env.GITHUB_RUN_ID,
  runAttempt: env.GITHUB_RUN_ATTEMPT,
  server: env.GITHUB_SERVER_URL,
});
const output = (key, value) =>
  appendFileSync(
    env.GITHUB_OUTPUT,
    `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
const claim = () => JSON.parse(env.CLAIM);
const git = (...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

switch (process.argv[2]) {
  case "claim": {
    if (env.OPENAI_KEY_PRESENT !== "true")
      throw new Error("Configure OPENAI_API_KEY before enabling automation.");
    const number = env.ISSUE_NUMBER ? Number(env.ISSUE_NUMBER) : undefined;
    if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
      throw new Error("Invalid issue number.");
    if (env.RETRY === "true" && !number)
      throw new Error("Retry must name one issue.");
    automation.claim({
      number,
      retry: env.RETRY === "true",
      onClaim: (value) => {
        output("claim", value);
        output("claimed", "true");
      },
    });
    break;
  }
  case "guard": {
    const result = automation.guard(claim());
    output("safe", String(result.safe));
    output("reason", result.reason || "");
    if (result.sha) output("sha", result.sha);
    break;
  }
  case "publish": {
    const record = claim();
    const result = automation.guard(record);
    if (!result.safe) {
      output("outcome", "held");
      output("message", result.reason);
      break;
    }
    const report = JSON.parse(readFileSync(env.REPORT_PATH, "utf8"));
    validateReport(report);
    const actualDigest = createHash("sha256")
      .update(readFileSync(env.PATCH_PATH))
      .digest("hex");
    if (!env.PATCH_DIGEST || actualDigest !== env.PATCH_DIGEST)
      throw new Error("Patch differs from the verified artifact.");
    git("apply", "--index", "--binary", env.PATCH_PATH);
    const paths = git("diff", "--cached", "--name-only", "-z")
      .split("\0")
      .filter(Boolean);
    if (!paths.length) throw new Error("Agent produced no changes.");
    git("switch", "-c", record.branch);
    git(
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      `Implement #${record.issue}: ${record.snapshot.title}`,
    );
    git("push", "origin", `HEAD:refs/heads/${record.branch}`);
    const sha = git("rev-parse", "HEAD").trim();
    api(`repos/${record.repository}/statuses/${sha}`, "POST", {
      state: "success",
      context: "Codex pre-publication verification",
      description:
        "Repository CI passed on this exact patch before publication.",
      target_url: record.runUrl,
    });
    const tag = `<!-- codex-issue:${record.repository}#${record.issue} -->`;
    const closing =
      record.base === "main"
        ? `Closes #${record.issue}.`
        : `Related issue: ${record.issueUrl}. Leave open until this work reaches main.`;
    const body = `${tag}\n${closing}\n\n${report.summary}\n\nVerification:\n${report.checks.map((check) => `- Passed: ${check.command}`).join("\n")}\n\nRepository CI also passed on the proposed patch before publication.\n\n[Implementation run](${record.runUrl}). Engineer review is required before merge.`;
    const pr = api(`repos/${record.repository}/pulls`, "POST", {
      title: `Implement #${record.issue}: ${record.snapshot.title}`.slice(
        0,
        250,
      ),
      head: record.branch,
      base: record.base,
      body,
      draft: false,
    });
    // Record the PR before finalization so a reporting failure cannot lose its URL.
    output("pr_url", pr.html_url);
    output(
      "message",
      `${pr.html_url} — implementation checks, code review, and pre-publication repository CI passed.`,
    );
    output("outcome", "success");
    break;
  }
  case "finish": {
    let status = "failed";
    let message =
      "The attempt did not complete successfully. Inspect job logs and preserved artifacts before retrying.";
    if (env.PREFLIGHT_SAFE === "false") {
      status = "held";
      message = env.PREFLIGHT_REASON;
    } else if (env.PUBLISH_OUTCOME === "held") {
      status = "held";
      message = env.PUBLISH_MESSAGE;
    } else if (env.PUBLISH_OUTCOME === "success") {
      status = "success";
      message = env.PUBLISH_MESSAGE;
    } else if (env.PR_URL) {
      message = `PR was created at ${env.PR_URL}, but a later publication step failed. Do not retry implementation while this PR is open; inspect its verification and run logs.`;
    } else if (env.CLAIM_RESULT === "success") {
      // Drift still holds work when implementation or verification failed before publication.
      // A partial/failed assignment is a setup failure, not external issue drift.
      try {
        const result = automation.guard(claim());
        if (!result.safe) {
          status = "held";
          message = result.reason;
        }
      } catch (error) {
        message += ` Final eligibility read: ${error.message}`;
      }
    }
    automation.finish(claim(), status, message);
    break;
  }
  default:
    throw new Error("Expected claim, guard, publish, or finish.");
}
