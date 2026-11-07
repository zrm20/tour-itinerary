# Codex issue implementation

The opt-in `Codex issue implementation` workflow claims one eligible issue and starts the official Codex Action. Codex follows the fixed prompt and installed `implement` skill, uses GitHub MCP to manage the issue and open a PR, and leaves the work for engineer review. The workflow supplies a small eligibility gate and crash recovery; implementation, checks, review, and publication belong to the agent.

## Activation

1. Store an OpenAI Platform API key as the repository Actions secret `OPENAI_API_KEY`. API usage is billed separately from ChatGPT subscriptions. Use project spending controls; the 60-minute agent timeout is not a dollar cap.
2. In **Settings → Actions → General**, allow Actions to create pull requests. Organization policy must permit this. Ensure `zrm20` is assignable.
3. Merge the reviewed workflow into `main`. Review the existing `ready-for-agent` backlog, then set repository Actions variable `CODEX_ISSUES_ENABLED=true`. The label authorizes autonomous execution once the issue is eligible.

Set the variable to `false` to stop new pickups; cancel a running Actions run separately. The workflow uses GitHub-hosted runners and the OpenAI API, not the existing Codex cloud environment.

## What runs

Issue closure, reopening, and adding `ready-for-agent` trigger scans. A scan also runs every 15 minutes, at minutes 7, 22, 37, and 52, to catch removed dependencies and missed events. Each scan picks the oldest eligible issue. GitHub schedules may be delayed. The concurrency group runs one attempt at a time across the repo; an open PR does not block another independent issue.

The gate requires an open, unassigned `ready-for-agent` issue, no open native blockers, and no open implementation PR (including human PRs). Previous claims, `agent:failed`, `agent:held`, and linked closed-unmerged PRs require explicit retry. Convert `Blocked by:` fallback text to native dependencies before pickup. API errors stop execution. Dependency and PR connections are paginated; private cross-repository links remain limited by token visibility.

The gate records a bot claim comment with the run and attempt branch, assigns `zrm20`, snapshots the issue, and resolves the latest selected base. The base defaults to `main`. Override it with exactly one standalone `Base branch: codex/parent-feature` line in the issue body; it must name an existing branch in this repository. Attempts use `codex/issue-<number>-<title-slug>-<run-id>-<attempt>`. Retries start fresh from the latest selected base.

The fixed prompt is [`.github/codex/implement.md`](../../.github/codex/implement.md). It explicitly invokes `$implement`, which remains available when implicit invocation is disabled. The agent performs TDD, checks, code review, commits, pushes, and PR creation. It must invoke the gate's `check` command before work and immediately before publication. The check compares title, body (including the base declaration), state, assignees, readiness, blocker identities/states, claim ownership, and linked open PRs. Changes hold publication; ordinary comments do not invalidate the snapshot. GitHub offers no atomic transaction between that read and PR creation.

GitHub MCP is configured in [`.github/codex/config.toml`](../../.github/codex/config.toml) using the job's repository-scoped, short-lived `GITHUB_TOKEN` through `GH_TOKEN`. No token value is committed. The required remote server must initialize or the agent fails. Issue/PR work uses MCP; local Git handles commits and pushes, and `gh` supplies native dependency or complete linked-PR data not exposed by MCP. See [GitHub's MCP authentication guide](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md) and [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The agent runs on a disposable hosted runner with GitHub issue, content, and PR write access. The action drops sudo; its sandbox permits runner filesystem/network access for Git, MCP, and local tests. The prompt prohibits merging, deploying, closing issues early, and unrelated work; the MCP merge tool is disabled. These are agent responsibilities, rather than an independent publisher enforcing completion. Every change still requires engineer review.

## Results and recovery

The agent opens a PR ready for review only after implementation, required checks, and code review finish. It comments on the issue with the PR URL and verification summary, keeping the assignment and issue open. A main-target PR uses `Closes #<number>`; alternate-base PRs reference the issue and leave it open until the work reaches main or an engineer closes it. The PR body includes the automation's issue marker for duplicate detection.

Normal PR CI performs the repository checks. GitHub may require an engineer to approve workflows for bot-created PRs; the automation does not bypass that approval. There is no separate patch-verification job, structured completion report, or scripted publisher. If Prisma blocks the existing destructive reset test inside Codex, the agent reports it as delegated to normal PR CI instead of bypassing the guard or claiming it passed.

The agent comments and adds `agent:failed` for incomplete work, failed checks, or unresolved review findings; it uses `agent:held` when the issue changes. Both retain assignment and readiness. A fresh recovery job handles setup failures, crashes, timeouts, and a normal exit without the expected PR. It preserves an agent-reported stop label, and otherwise reports a failure/hold when needed. A normal exit with the attempt PR present is not independent proof that the agent completed every instruction.

Progress commits should be pushed to the attempt branch. Available local commits, tracked changes, non-ignored untracked files, prompt, claim, and summary are also preserved as artifacts for 14 days. Preservation and reporting are best effort after hard runner loss or manual cancellation. The agent gets 60 minutes; the job reserves additional setup/cleanup time. A recorded claim prevents automatic retries even if recovery cannot finish.

To start one particular issue, use **Actions → Codex issue implementation → Run workflow**, select `main`, and enter the issue number. Set `retry=true` for an intentional fresh attempt. A retry still requires an open, ready, unblocked issue without an open implementation PR. Assignment can be bypassed only when a recorded claim belongs to `zrm20` and `zrm20` is still the sole assignee; an unassigned issue can also be retried. A successfully claimed retry clears the supplemental stop labels. Use a fresh dispatch rather than **Re-run jobs**.

Removing assignment or labels alone does not reset claim history. Inspect an existing PR before retrying, and close an abandoned PR first. Workflow-file pushes can be refused by `GITHUB_TOKEN` policy; inspect the preserved work for manual publication in that case. If GitHub MCP authentication or reporting fails, inspect Actions logs and repair access before retrying.

## Local checks

Run `node --test scripts/agents/gate.test.mjs` from the repo root. The suite covers eligibility, retry ownership, claims, drift, and crash recovery without writing to GitHub or calling OpenAI. CI runs the same tests. Validate workflow syntax with `actionlint` when editing orchestration.
