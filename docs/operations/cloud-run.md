# Development Cloud Run bootstrap and recovery

This is preparation for one disposable, shared development environment. An engineer
reviews and merges the code, owns the Google account/project/billing account, reviews
private Terraform plans, and performs the applies. No cloud resources have been
provisioned by this change. There are no availability or production guarantees.
The application remains health-only, with no database, application secrets, or
runtime Google API privileges. Never expose application data under this public policy.

## Toolchain and ownership

Use Terraform **1.17.1**, Google provider **8.9.0** (committed lockfile), gcloud
**591.0.0**, and Node **24.22.2**. The selected Terraform and provider releases were
checked against their upstream releases; configuration validates against this provider.
Actions major versions follow the existing repository convention. CI validates
Terraform without credentials and runs the application checks and production-image test.

Terraform owns APIs, Artifact Registry and cleanup, service accounts, IAM, WIF,
public invocation, startup probe, CPU/memory, request-based billing, scaling, and the
project alert budget. The project and state bucket are the deliberately minimal
out-of-Terraform foundation; the engineer maintains and inventories them. They are
not implicitly adopted by `terraform apply` and are not destroyed by it. Import any
other pre-existing resource into its matching address before applying; never blindly
recreate or take ownership of someone else's infrastructure.

Actions owns only the deployed image, source/release labels, revision identity,
candidate tags, and traffic. The lifecycle exclusions name those exact fields,
including source/release labels and narrowly named gcloud client/version annotations copied to service and revision.
No environment, probe, resource, secret-reference or scaling block is ignored.
`google_cloud_run_service` intentionally uses the supported v1 API representation:
`autogenerate_revision_name` omits the old immutable revision name during an
infrastructure update. Merely ignoring a v2 template revision would preserve its old
name on updates and can prevent Terraform from creating a changed revision.
The v1 and v2 APIs describe the same Cloud Run service; do not manage it twice.

Routine delivery never runs Terraform. Its identity has Artifact Registry Writer on
this repository, Cloud Run Developer on this service (created only in phase two),
Service Account User on this runtime account, and a custom project role containing
only `run.operations.get` for gcloud's regional long-running-operation polling.
There is no IAM/billing administration, state-bucket access, or project Owner/Editor.
Runtime has no application grants. Cloud Run's Google-managed service agent pulls
images in the same project; do not give registry credentials to the application.

## 1. Account, billing, project and private state

1. The engineer creates a Google account, enables MFA and recovery, and creates or
   selects a billing account they control. Confirm USD billing for these USD budgets,
   ongoing free-tier eligibility and organization policies that permit public Cloud Run
   and external WIF. Do not depend on temporary trial credits.
2. Create a dedicated project and attach billing. Record its ID, number, billing
   account, owner and deletion/recovery contact privately. Do not reuse a project
   containing unrelated workloads. An organization may require its administrator for
   project creation, public `allUsers` access, API enablement or billing linkage.
3. Use personal credentials, never a downloaded service-account key:

   ```sh
   gcloud auth login
   gcloud auth application-default login
   gcloud projects create "$PROJECT_ID" --name='Tour itinerary development'
   gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
   gcloud config set project "$PROJECT_ID"
   gcloud services enable serviceusage.googleapis.com storage.googleapis.com --project="$PROJECT_ID"
   ```

   The engineer's infrastructure identity needs the ability to enable APIs, manage
   the resources/IAM declared under `infra/`, and manage budgets on the billing
   account (Billing Costs Manager or equivalent approved access). These are personal
   infrastructure privileges; never grant them to GitHub delivery. Use your organization's
   approved grants rather than copying a project-wide Owner role to automation.
4. Choose a globally unique `$STATE_BUCKET`. Create it in **us-east1**, with uniform
   access and enforced public-access prevention; retain bounded previous versions:

   ```sh
   gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
     --location=us-east1 --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update "gs://$STATE_BUCKET" --versioning
   ```

   Save this lifecycle JSON in a private temporary file and apply it using
   `gcloud storage buckets update "gs://$STATE_BUCKET" --lifecycle-file=PATH`:

   ```json
   {"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":30}},{"action":{"type":"Delete"},"condition":{"isLive":false,"numNewerVersions":10}}]}
   ```

   Either condition independently deletes old noncurrent versions, bounding history
   to at most ten versions and thirty days (lifecycle enforcement is asynchronous).
   Check soft-delete settings too: explicitly use
   `gcloud storage buckets update "gs://$STATE_BUCKET" --soft-delete-duration=7d`
   and include those seven days of recoverable objects in retention/cost expectations.
   Keep live state indefinitely. Do not enable a bucket retention lock that prevents
   Terraform lock-object deletion. Verify using `gcloud storage buckets describe`:
   location, versioning, lifecycle, soft-delete, uniform access, and public prevention.
5. Grant bucket-level Storage Object Admin only to approved infrastructure engineers
   (including a recovery engineer); confirm inherited project access is appropriate.
   Do not grant any bucket role to deployment/runtime accounts, `allUsers`, or
   `allAuthenticatedUsers`. Inspect bucket and project IAM and test that an
   unauthenticated read is denied. State may contain sensitive infrastructure details.
   Keep local ADC, state exports and saved plans private and out of Git/artifacts.
6. Copy `infra/backend.hcl.example` to gitignored `infra/backend.hcl`, set the bucket,
   and keep prefix `tour-itinerary/dev`. Copy `terraform.tfvars.example` to gitignored
   `terraform.tfvars`. Obtain IDs with:

   ```sh
   gh api repos/zrm20/tour-itinerary --jq '{repository_id: .id, owner_id: .owner.id}'
   ```

   These immutable IDs, not mutable repository/owner names, bind federation.
   Set `project_id` and `billing_account`, leaving `enable_service = false`.

GCS remote state supports Terraform's object-based locking. Never use `-lock=false`.
If a lock is abandoned, verify no apply is running, record the lock ID and obtain
engineer agreement before `terraform force-unlock ID`. To recover state, stop all
applies/releases, list object generations (`gcloud storage ls --all-versions`), copy
an appropriate generation to a private recovery file, inspect state lineage/serial,
and restore with the Terraform state recovery workflow (`terraform state push`, only
with a reviewed backup). Do not use `-force` casually. Verify a private refresh-only
plan afterward. The bucket/project outlive `terraform destroy`; delete them explicitly
only after reviewed teardown, billing checks and any recovery window.

## 2. Foundation apply, billing controls, GitHub variables

From `infra/`:

```sh
terraform init -backend-config=backend.hcl -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform plan -out=foundation.tfplan
# Engineer reviews the plan locally; never upload the plan or state.
terraform apply foundation.tfplan
rm foundation.tfplan
terraform output
```

This creates APIs, registry, identities/federation, alert budget and IAM; it does not
create Cloud Run or its service-level deployment grant. No placeholder image is used.
If policy prevents API or IAM setup, resolve it with the engineer before progressing.

Set GitHub **development environment variables** from Terraform outputs:

| Variable | Terraform output |
| --- | --- |
| `GCP_PROJECT` | `project_id` |
| `WORKLOAD_IDENTITY_PROVIDER` | `workload_identity_provider` |
| `DEPLOYMENT_SERVICE_ACCOUNT` | `deployment_service_account` |

The service name is fixed at `tour-itinerary-api` and region at `us-east4` in both
Terraform and delivery. Configure the environment to allow main only. There is no
routine post-merge manual approval gate. Protect main with engineer review and the
entire CI workflow as required checks, including the infrastructure job. Restrict
workflow edits with the repository's review controls. Do not configure Google keys
as Actions secrets.

The Terraform budget is **project-wide $5/month, alerts only**, with actual-spend
thresholds **50%, 90%, 100%**. Default billing admin/user email notifications remain
enabled. In Billing > Budgets & alerts, verify project scope, USD 5, calendar month,
thresholds and intended recipients; the engineer must verify notification receipt.

A **separate $5/month Cloud Run spend-cap budget** is mandatory before service
creation. Google provider 8.9.0's `google_billing_budget` schema does not expose the
spend-cap/enforcement control; an ordinary budget is not a substitute. Engineer step:
open the linked billing account's **Budgets & alerts**, create a second budget scoped
to this project and the **Cloud Run** service, calendar month, **USD 5**, and enable
the **Cloud Run spend cap** control. Follow the current
[Google spend-cap instructions](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
for the enforcement confirmation. Reopen the saved budget and confirm that it is
marked as an **enabled/enforced Cloud Run spend cap**, with the correct project,
service and amount; record its budget ID and redacted confirmation in the engineer
bootstrap evidence. If the console/account cannot enable this control, stop bootstrap
and resolve its availability; do not silently proceed with a second alerts-only budget.
Automation has no billing permission and never raises, disables or lifts the cap.

A cap can enforce downtime and resets monthly; only the engineer may explicitly lift
it. Enforcement lags and billable overages remain possible. Other services are outside
its scope; gross estimates before credits/savings may trigger enforcement early.
Neither this cap, max two instances nor free allowances guarantees a $5 total bill.
Artifact Registry's 0.5 GiB free storage need not fit the retained images. Cleanup
asynchronously deletes images older than 14 days, keeps the five newest, and protects
`current`/`previous` tags regardless of age. Only those two movable protection tags
are maintained; never create extra tags starting with those prefixes. The moving
references and bounded recent window avoid an indefinitely growing protected history.
Inspect cleanup and storage costs; Cloud Logging, state versions and network usage
can also incur charges. See [registry pricing](https://cloud.google.com/artifact-registry/pricing).

## 3. Publish verified main before creating the service

1. Merge engineer-reviewed changes; wait for **CI** success on the actual main SHA.
   Note the CI run ID. PR CI artifacts are deliberately ineligible. Artifacts expire
   after seven days; if missing, rerun CI for current main, never rebuild in delivery
   or bypass checks. The automatic release may fail because the service does not
   exist yet; that failure must not create a service.
2. Dispatch **Development release** on **main**, mode **publish-only**, supplying
   that CI run ID and `fail_check=none`. It validates repository, push event, main,
   workflow path, successful CI and current main head; loads the retained exact
   image, checks its source label, starts it and verifies real HTTP health again
   before Google authentication, then publishes the same image with the source SHA.
   The summary supplies the immutable registry digest, SHA and run links. No service
   creation, Terraform, traffic changes, or rebuild occurs in this mode.
3. Set `enable_service = true`, `bootstrap_image` to that exact digest, and
   `bootstrap_commit` to its full source SHA in private `terraform.tfvars`.
   Keep these initial values after bootstrap; lifecycle exclusions preserve later
   releases. Review a new private plan and apply it. This creates the first revision,
   public invoker policy and service-level deployment grant.
4. Cloud Run creation initially serves the first image. **There is no previous
   revision or automatic fallback**. Read the created revision and URL:

   ```sh
   gcloud run services describe tour-itinerary-api --project="$PROJECT_ID" \
     --region=us-east4 --format=json
   node backend/scripts/verify-health.mjs --url "$SERVICE_URL/health" --commit "$SOURCE_SHA"
   gcloud run services update-traffic tour-itinerary-api --project="$PROJECT_ID" \
     --region=us-east4 --to-revisions="$FIRST_REVISION=100"
   gcloud artifacts docker tags add "$BOOTSTRAP_DIGEST" \
     "us-east4-docker.pkg.dev/$PROJECT_ID/tour-itinerary/api:current" --project="$PROJECT_ID"
   ```

   Verify first revision's image digest and `source-commit` label. Verify explicit
   traffic again and health after pinning. If the first image fails, stop declaring
   bootstrap successful: diagnose logs/cap/config, publish a newly checked main image
   and use an engineer-reviewed recovery. There is nothing to roll back to.
5. Record first health/commit, digest, revision, URL, notification/cap confirmation,
   IAM restriction tests and private plan review evidence. These are live engineer
   acceptance steps, not claims established by local validation.

## Routine release behavior and recovery

The workflow starts after successful merged-main CI, or a main-only manual dispatch
of a successful CI run. One concurrency group covers publication, mutation, checks,
promotion and recovery. `cancel-in-progress: false` finishes the active release;
GitHub replaces older pending jobs with the newest waiting one. Out-of-order CI
completions and stale reruns are skipped by querying current main, both before
credentials and immediately before service mutation. A newer push arriving during
an active candidate does not cancel that active release. The next eligible release
follows it. A rerun already serving the same SHA verifies health and does no mutation
unless an engineer explicitly selects a controlled failure.

Before candidate creation, capture one 100% serving revision with a valid full source
label and digest, verify its health and protect its image as `previous`. Mixed or
unknown traffic/metadata fails closed for manual reconciliation. Pin normal traffic
to that explicit revision, clear old candidate tags, then deploy an immutable image
with a unique `r<run-id>-<attempt>` revision suffix and corresponding candidate tag,
with `--no-traffic`. The startup HTTP probe allows 20 failures at a three-second
period, two-second timeout. Candidate, normal and recovery smoke verification each
allows 15 attempts, two-second request timeout and two-second retry delay (about one
minute). Every check requires HTTP 200, JSON `status: "ok"`, and exact full commit.
CLI operations have a 180-second timeout; traffic convergence is observed six times
with two-second delays (about ten seconds plus API request time). The job has a
60-minute outer bound to leave recovery time; abrupt runner loss still needs manual
recovery. Never cancel an active release as a way to deploy faster.

Candidate failure leaves serving traffic unchanged and verifies the previous commit.
Successful candidate health promotes **the explicit candidate revision** to 100%, then
verifies the normal URL. After an ambiguous promotion CLI failure, inspect converged
actual traffic: if the candidate received 100% and verifies, delivery may succeed;
otherwise restore the explicit previous revision and verify its commit. Any failure
after a promotion attempt keeps the workflow failed even after verified recovery.
Rollback CLI errors are also reconciled against actual traffic. An inability to read,
restore, settle or verify recovery is separately marked **ROLLBACK/RECONCILIATION
FAILED** in the summary, together with the final readable traffic state and log links.

The JSON summary includes source, digest, candidate/previous identity and metadata,
URLs, per-phase verification, final observed traffic, recovery, workflow and logs.
Publication has its own summary with the checked CI run link, including publish-only.

Manual recovery, under the same exclusive maintenance window:

```sh
gcloud run services describe tour-itinerary-api --project="$PROJECT_ID" --region=us-east4 --format=json
gcloud run revisions describe "$KNOWN_REVISION" --project="$PROJECT_ID" --region=us-east4 --format=json
# Compare image, source-commit label and prior successful workflow summary.
gcloud run services update-traffic tour-itinerary-api --project="$PROJECT_ID" \
  --region=us-east4 --to-revisions="$KNOWN_REVISION=100"
# Even if the preceding CLI fails, read actual traffic before choosing the next action.
gcloud run services describe tour-itinerary-api --project="$PROJECT_ID" --region=us-east4 --format=json
node backend/scripts/verify-health.mjs --url "$SERVICE_URL/health" --commit "$KNOWN_COMMIT"
```

Repair `current` and `previous` registry tags to match the verified serving image and
retained fallback after manual recovery. Keep a failed workflow failed; record recovery
separately. Inspect logs through the workflow link or
`gcloud run services logs read tour-itinerary-api --region=us-east4 --project="$PROJECT_ID" --limit=50`.
For unexplained 403/503/unavailability, check Cloud Run revision readiness/startup logs,
IAM and the Billing console's spend-cap enforcement status. If the cap is enforced,
changing application revisions will not fix it: accept downtime until reset or have
the engineer explicitly decide whether to lift it. Never automate that decision.

## Coordinating infrastructure applies

Disable **Development release** temporarily (`gh workflow disable release.yml`), wait
for active delivery to finish, and inspect/cancel pending runs before acquiring the
maintenance window. All engineers coordinate; GCS locking serializes Terraform but
does not lock gcloud traffic changes. Capture the explicit serving revision/digest/
commit and health. Pin traffic to that revision before a manual apply. Review the
private plan: image, source/release labels and traffic must remain the deployed values;
ordinary configuration must still show intended differences. Apply only after review.

If Terraform creates a new configured revision, existing explicit traffic must stay
on the prior verified revision. Inspect `latestCreatedRevisionName`, image/commit and
configuration, add a temporary engineer candidate tag with `update-traffic --update-tags`,
verify its tagged health against the image's source commit, then explicitly promote
that revision and verify normal health. Recover to the captured previous revision
if needed. Do not promote `latest`. Recheck a private Terraform plan after a routine
release: it must not revert digest/metadata/tags/traffic or hide ordinary drift.
Reenable delivery (`gh workflow enable release.yml`) and dispatch current checked main
if its automated trigger occurred during maintenance.

## Local verification

Run `npm ci && npm run check` from `backend/`. This includes process-level release
simulations with a real local HTTP verifier and simulated external GitHub/gcloud
commands: checked-main eligibility, PR/fork/unrelated CI rejection, candidate failure,
promotion timeout with changed/unchanged traffic, failed normal verification,
verified rollback, ambiguous rollback, failed rollback, and missing first service.
The federation policy's configured equality/conjunction/membership subset is exercised
with trusted main and rejected PR/fork/unrelated-workflow claims; this does not replace
Google's live OIDC evaluation.

From `infra/`, run `terraform init -backend=false -lockfile=readonly`,
`terraform fmt -check -recursive`, `terraform validate`, and `terraform test`.
Every test uses `mock_provider "google"`; no real resource, ADC or state backend is
used. A synthetic externally released state verifies that plans preserve the deployed
digest, source/release labels, explicit traffic and candidate tags while correcting
ordinary timeout and scaling drift. Also run `actionlint` on the workflows.
No account-backed plans or live deployment are performed by these checks.

## Live engineer acceptance checklist

- Record source SHA, successful CI and release run links, source label, published
  immutable digest and candidate/normal exact-commit health; confirm no database.
- Inspect WIF provider condition and attempt credentials from a PR, a fork, a
  separate main workflow, and a non-main dispatch: each must fail. A trusted main
  release succeeds. Use throwaway identity-only workflows that do not publish or
  mutate resources; delete them after evidence. Do not relax the provider condition
  or grant a key to make a negative test work. Verify deploy/runtime cannot read
  the state bucket, administer IAM/billing, or access application APIs/secrets.
- Merge two reviewed harmless commits close together; confirm active rollout
  finishes, pending superseded work skips, newest checked main wins. Rerun an older
  release and confirm it reports skipped before service changes.
- On a healthy existing service dispatch current-main release with `fail_check=candidate`:
  it must fail, preserve previous traffic and verify previous commit. Then dispatch
  `fail_check=normal`: candidate verifies, promotion happens, the controlled verifier
  fails, previous explicit revision is restored and verified, workflow remains failed.
  The switch affects verification only; application data/config are not modified.
- Simulate ambiguous CLI results and failed rollback using local delivery simulations;
  do not corrupt live access or deliberately break billing. Record live rollback
  success and manual recovery commands separately from simulated failure evidence.
- After delivery, inspect a private Terraform plan for ownership preservation, and
  introduce a reviewed ordinary configuration change to confirm it remains managed.
- Verify budget recipients/thresholds, cap enabled state, registry protection and state
  IAM/lifecycle. Keep account-specific identity/access, plan and cost evidence private;
  publish only redacted results and workflow links in the bootstrap issue.

Code review/merge completes code preparation only. Actual account creation, reviewed
account-backed plans, WIF access tests, notifications and live rollout evidence belong
to the engineer bootstrap issue; no local/static result substitutes for them.
