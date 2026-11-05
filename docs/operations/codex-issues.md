# Codex issue implementation

The `Codex issue implementation` workflow uses the official OpenAI Codex Action to implement ready issues and open PRs for engineer review. It is disabled unless the repository variable `CODEX_ISSUES_ENABLED` is exactly `true`. It runs on GitHub-hosted runners; it does not use the Codex cloud environment or ChatGPT subscription authentication.

## Setup and activation

1. Create an OpenAI Platform API key for this automation, preferably in a dedicated project with spending alerts and appropriate model access. Store it as the repository Actions secret `OPENAI_API_KEY`. Never put the key in an issue, prompt, or committed file. API usage is billed to that project. The 60-minute implementation timeout bounds runner time, not dollar spending.
2. In repository **Settings → Actions → General → Workflow permissions**, allow GitHub Actions to create pull requests. Organization policy must also permit this. The workflow explicitly grants its jobs the GitHub permissions they need; no personal access token is required.
3. Ensure `zrm20` remains assignable to issues in this repository. Assignment is the visible in-progress signal. The hidden claim record in a bot comment identifies automation-owned assignments and attempts.
4. Merge the reviewed workflow into `main`. Review all existing open `ready-for-agent` issues: enabling the workflow authorizes implementation of the eligible backlog, not only future transitions. Applying that label authorizes autonomous execution and API spending once dependencies are satisfied.
5. Set repository Actions variable `CODEX_ISSUES_ENABLED` to `true`. To pause new pickups, set it to `false`. To stop a current attempt, also cancel its Actions run; disabling pickups does not cancel a running job.

The official action is pinned to a reviewed commit. The CLI and model use the action's defaults; changing the action revision or selecting a CLI/model is a reviewed workflow change. See [OpenAI's Codex Action documentation](https://learn.chatgpt.com/docs/github-action) for its authentication and permission controls.

## Eligibility and triggers

An issue must be open, labeled `ready-for-agent`, unassigned, and have no open native GitHub blockers or open implementation PR. A human-authored linked PR counts. Previous automation claims, `agent:failed`, `agent:held`, or a linked closed-unmerged PR prevent automatic pickup. Existing closed blockers are allowed. Convert the documented `Blocked by:` fallback to native dependencies before automatic implementation; the workflow refuses the fallback rather than guessing.

Issue closure, reopening, and adding `ready-for-agent` trigger a scan. A scan runs every 15 minutes at minutes 7, 22, 37, and 52 to catch dependency removals and missed events. GitHub schedules may be delayed. Each scan selects the oldest eligible issue. Only one workflow runs at a time across the repository; queued events recheck current eligibility when they run. Open PRs do not prevent other independent issues from being implemented. Model dependencies on unfinished work explicitly.

Any actor can cause a scan, including by closing a blocker. The action therefore permits all trigger actors, but only issues with the maintainer-controlled readiness label can reach Codex. Review access to that label as authorization to execute work. Every issue/dependency/PR API read must succeed; errors stop the run rather than treating missing data as eligibility.

Native closing links are queried regardless of PR author, with pagination. The automation also recognizes its own PR marker and recorded branch, including PRs into an alternate base. An ordinary mention of an issue does not count as a human implementation link: use GitHub's Development sidebar or closing keywords. Visibility of cross-repository private PRs is limited by `GITHUB_TOKEN` access.

## Prompt, base, and branches

The fixed prompt lives in [`.github/codex/implement.md`](../../.github/codex/implement.md). Only the issue URL is substituted. It invokes the installed `implement` skill, including its TDD, verification, code-review, and local commit requirements. No issue content is interpolated into executable shell code.

The base defaults to `main`. To override it, include exactly one standalone line in the issue body:

```text
Base branch: codex/parent-feature
```

The override must be a literal, existing branch in this repository. URLs, fork syntax, multiple declarations, and missing branches fail the attempt. The base resolves to its latest SHA immediately before the implementation job; all later verification uses that exact SHA. Subsequent movement of `main` alone does not invalidate the attempt.

Branches have the form `codex/issue-<number>-<title-slug>-<run-id>-<run-attempt>`. Every retry gets a new branch from the latest selected base; it never resumes another attempt's working tree. The agent commits locally. A separate trusted job publishes the final patch as one commit and opens the PR, preserving the issue-derived branch name. No agent receives a GitHub write token.

## Verification and publication

Claiming records the issue and expected assignment, assigns `zrm20`, then verifies the claim. Before implementation and publication, the workflow compares title, body, open state, assignees, readiness, and all blocker identities/states with that snapshot. It also checks for a newly opened implementation PR and an unchanged claim record. Ordinary comments and supplemental status-label changes do not invalidate the snapshot. Removing and later restoring a field between reads cannot be detected by snapshot comparison.

Incomplete implementation, failed or unrun required checks, or unresolved code-review findings count as failure. The agent must provide a structured completion report. The existing destructive database-reset test can be delegated to independent CI if Prisma's agent guard blocks it inside Codex: the agent must report the delegation and must not bypass the guard. Independently, the reusable repository CI runs the proposed patch through backend checks, the full PostgreSQL integration suite, production-image smoke checks, Terraform checks, and automation tests before publication. Artifacts are downloaded by immutable ID, and a trusted SHA256 recorded before verification code executes binds publication to the verified patch. Control tests run from the trusted workflow revision even when an alternate base predates these files. A structured report is evidence from the agent, not independent proof of review quality; engineer review remains required.

Publication uses a fresh checkout and GitHub write credentials that are absent from the implementation and verification runners. It rechecks the issue, applies the verified patch, pushes the branch, records a successful `Codex pre-publication verification` status on the published commit, and opens a PR ready for review. Normal PR CI for bot-created PRs can require an engineer to select **Approve workflows to run** in GitHub; see [GitHub's workflow triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

The publisher does not execute or dispatch generated workflow definitions. GitHub token policy may refuse pushes that modify workflow files; those attempts fail with the patch preserved for manual publication. The automation does not deploy or merge work.

On success, the workflow comments with the PR and verification summary, keeps the issue assigned and open, and uses `Closes #<number>` for a PR targeting `main`. An alternate-base PR links the issue in its body and the issue's result comment, uses the automation marker for duplicate detection, and leaves the issue open until the work reaches `main` or an engineer closes it. It does not add a native closing link for that intermediate PR.

## Failures, held work, and retries

- **`agent:failed`**: implementation, checks, timeout, setup, or publication failed. The issue comment links to the run and available artifacts. If a PR already exists, inspect or repair that PR; do not start a duplicate implementation.
- **`agent:held`**: the issue, ownership, claim, dependencies, or linked PR changed, so publication was withheld. Inspect the result before deciding whether to retry.

These are supplemental status labels, not new triage states. They are created when first needed. Both retain the existing assignment and readiness label. Neither state is automatically retried. Available patches, prompts, and reports are retained as Actions artifacts for 14 days. A hard runner loss or early setup failure can leave only logs; preservation and finalization cannot be guaranteed after platform interruption or manual cancellation. A recorded claim still prevents automatic re-execution.

To start a particular unassigned eligible issue, run **Actions → Codex issue implementation → Run workflow**, select `main`, enter its issue number, and leave `retry` false. To retry, set `retry` true. An explicit retry still requires an open, ready, unblocked issue with no open implementation PR. It may bypass assignment only when the latest recorded automation claim identifies `zrm20` as owner and `zrm20` is still the sole assignee. Unassigned issues may be explicitly retried after an abandoned human PR. A successfully claimed retry clears `agent:failed` and `agent:held`.

Use a new workflow dispatch for retries, rather than GitHub's **Re-run jobs**. Old claim ownership and completed-state checks prevent accidental duplicate publication; a fresh dispatch records a fresh attempt and base. After a closed-unmerged PR, close out or inspect its work and explicitly retry the issue. Removing the assignment or status label alone does not reset the automation history.

If a reporting job itself fails, inspect Actions logs before making changes. Repair repository permissions or API access, then deliberately retry. Claims and final readiness reads are serialized for this automation, but GitHub provides no atomic transaction spanning issue assignment, human edits, branch pushes, and PR creation. A human can change the issue just after the final read; review the PR and cancel work when necessary.

## Local verification

From the repository root, run `node --test scripts/agents/*.test.mjs`. The suite exercises eligibility, retry ownership, claim persistence, snapshot drift, failure/hold reporting, and completion-report validation without writing to GitHub or calling OpenAI. Validate workflow syntax with `actionlint` when editing orchestration. The existing CI also runs these automation tests.
