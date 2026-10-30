# Issue #10 code-preparation verification

Scope: [issue #10](https://github.com/zrm20/tour-itinerary/issues/10), including its
[binding delivery contract](https://github.com/zrm20/tour-itinerary/issues/4#issuecomment-6522087367).
Review baseline: `dd88ed4099f794df976ebd1ed1f629d53084688c`. The implementation and
review corrections are committed on the current local branch. These results apply
to the final committed source tree; use its commit SHA when transferring evidence
to an engineer-reviewed PR. No changes have been pushed or merged by this execution.

## Checks

- Node 24.22.2 / npm 11.19.1; locked install completed.
- `npm run check` in `backend/`: formatting, ESLint, TypeScript, **47 tests across
  five files**, and Nest production build passed. Focused health, release and
  federation tests were also run during implementation. A regression test first
  demonstrated that redirects were accepted; the verifier now rejects them.
- Terraform 1.17.1, Google provider 8.9.0: `fmt -check -recursive`, `validate`, and
  **five mocked test runs** passed. Ownership testing seeds synthetic released state
  and verifies preserved digest/metadata/traffic/tags while ordinary drift is fixed.
- `git diff --check`: passed.
- actionlint 1.7.12 passed with only its exact unknown `queue` field diagnostic
  suppressed. GitHub's current documented `queue: max` behavior is newer than this
  linter; see the [verification command and source](cloud-run.md#local-verification).
- Registry discovery is blocked by HTTP 403 in this workspace. For local provider
  validation, the official 8.9.0 archive was downloaded from HashiCorp releases and
  checked against its published SHA256SUMS. The lockfile includes all published
  platform archive hashes, plus the locally calculated linux_arm64 content hash.
- The production **linux/amd64** Docker build was attempted but this **ARM64** host
  has no amd64 execution emulation: the build stopped at `RUN npm ci` with
  `exec /bin/sh: exec format error`. No production-image success is claimed locally.
  The unchanged production-image build/start/health check remains required in CI
  on ubuntu-24.04 amd64 before any release is eligible.

## Standards

The independent Standards review found **zero documented-standard breaches or
actionable baseline smells**. A separate correctness observation identified the
pending-release queue problem also found by Spec; it was corrected.

## Spec

The independent Spec review initially found two issues: a stale queued run could
replace the newest eligible pending release, and custom IAM role creation could race
IAM API enablement. The final configuration uses `queue: max` with stale eligibility
checks and an explicit API dependency. The follow-up review confirmed both resolved:
**zero remaining reported Spec findings**. The 100-pending-run bound and redispatch
recovery are documented. Registry protection tags now advance only after successful
normal health, preserving the earlier fallback through controlled health failures.

## Handoff limits

No Google account-backed plan, apply, OIDC access attempt, cost notification or live
rollout was performed. No workflow run URL or deployed image digest exists for this
local execution. The [runbook](cloud-run.md) gives exact bootstrap and live acceptance
steps and the safe candidate/normal verification-failure mechanism. The engineer
bootstrap issue owns those live results. GitHub CLI authentication in this workspace
returns HTTP 401, so remote PR/issue evidence could not be published. Keep state,
saved plans, credentials and account-specific evidence private.
