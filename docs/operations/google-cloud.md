# Google Cloud development operations

Run commands from the repository root unless a section says otherwise. This guide operates the disposable, health-only development API: no database or application secrets are needed. Use the engineer's own Google account for infrastructure and recovery. Normal releases use GitHub federation, a dedicated delivery account, and a separate runtime account with no application IAM grants.

Use Node from `.nvmrc` (24.22.2), Terraform 1.17.1 with the committed Google 8.9.0 lockfile, GitHub CLI, Google Cloud CLI (release automation pins 591.0.0), and `jq`. Review repository changes before merging and private Terraform plans before applying. Keep state, saved plans, credentials, and account-specific policies out of Git and public artifacts. Commands that display billing or IAM information are for a private terminal.

## Ownership and operator settings

| Owner                       | Resources or fields                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engineer, outside Terraform | Account/billing/project creation, state bucket and its access/lifecycle, separate Cloud Run spend cap, local credentials, GitHub environment variables |
| Terraform                   | APIs, registry and image cleanup, workload accounts and IAM/federation, project alert budget, Cloud Run ordinary settings/public invocation            |
| Release workflow            | Verified image digest, source/release metadata, candidate revision identities/tags, traffic promotion and rollback, registry `current`/`previous` tags |

The outside-Terraform resources remain engineer-managed; the current configuration does not declare or import them. Terraform's GCS backend uses the pre-existing bucket. Routine releases never run Terraform. Do not add Owner/Editor, billing, state access, or IAM administration to either workload account to fix a deployment problem.

For an existing environment, obtain project and bucket identifiers from your private `infra/terraform.tfvars` and `infra/backend.hcl`. Set these shell variables; replace every example value:

```sh
export PROJECT_ID='YOUR_DEDICATED_PROJECT'
export STATE_BUCKET='YOUR_PRIVATE_STATE_BUCKET'
export BILLING_ACCOUNT_ID='YOUR_BILLING_ACCOUNT_ID'
export REGION='us-east4'
export SERVICE='tour-itinerary-api'
export REPOSITORY='tour-itinerary'
export GH_REPO='zrm20/tour-itinerary'
```

Authenticate interactively with `gcloud auth login`, `gcloud auth application-default login`, and `gh auth login` as needed. The CLI login and Terraform's Application Default Credentials are separate. After the project exists, run `gcloud auth application-default set-quota-project "$PROJECT_ID"`. Terraform also supplies its provider quota project explicitly; Billing Budgets requests using user credentials require it.

## Pause and resume releases

Before any Terraform apply, state repair, or manual traffic change, arrange a maintenance window with repository contributors. Prevent merges and manual dispatches during that window, then disable new releases:

```sh
gh workflow disable release.yml --repo "$GH_REPO"
gh run list --repo "$GH_REPO" --workflow release.yml --limit 100 \
  --json databaseId,status,conclusion,headSha
```

Disabling the workflow does not stop runs already queued or active. Wait for active releases to finish; inspect and resolve every outstanding queued/waiting run before proceeding. Do not cancel an active release during promotion/rollback. Recheck immediately before mutation. A GitHub concurrency group serializes workflow releases; it does not lock out a human's gcloud commands or Terraform.

After maintenance, verify health and actual traffic, record evidence on the originating issue, and re-enable the workflow:

```sh
gh workflow enable release.yml --repo "$GH_REPO"
```

Re-enabling does not replay a CI completion missed during maintenance. If needed, dispatch a release using a successful CI run for the current merged `main`, as below. A deliberate rollback to older code lasts only until another eligible release; decide with the engineer when releases may resume.

## Bootstrap a new environment

Use this section only for a new environment, not to recreate resources in an existing project.

1. In Google Cloud, establish an engineer-controlled billing account and a globally unique dedicated project ID. Confirm the selected billing account uses USD. The engineer needs project creation/billing-link access and permission to administer the project, state bucket and budgets. Do not use workload credentials for bootstrap.

   ```sh
   gcloud projects create "$PROJECT_ID" --name='Tour Itinerary development'
   gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
   gcloud services enable storage.googleapis.com serviceusage.googleapis.com \
     cloudresourcemanager.googleapis.com --project="$PROJECT_ID"
   gcloud auth application-default set-quota-project "$PROJECT_ID"
   ```

2. Create the private Standard-class state bucket in `us-east1` and configure its protections. The engineer controls its IAM; inspect inherited project convenience memberships as well as explicit grants. Delivery and runtime must have no state access. Do not make the bucket public or grant access to all project service accounts.

   ```sh
   gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
     --location=us-east1 --default-storage-class=STANDARD \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update "gs://$STATE_BUCKET" \
     --versioning --soft-delete-duration=7d
   cat > /tmp/tour-itinerary-state-lifecycle.json <<'JSON'
   {"rule":[
     {"action":{"type":"Delete"},"condition":{"isLive":false,"numNewerVersions":10}},
     {"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":30}}
   ]}
   JSON
   gcloud storage buckets update "gs://$STATE_BUCKET" \
     --lifecycle-file=/tmp/tour-itinerary-state-lifecycle.json
   gcloud storage buckets describe "gs://$STATE_BUCKET" --format=json
   gcloud storage buckets get-iam-policy "gs://$STATE_BUCKET"
   ```

3. Copy `infra/backend.hcl.example` to ignored `infra/backend.hcl` and `infra/terraform.tfvars.example` to ignored `infra/terraform.tfvars`. Set the actual bucket, project and billing account. Get immutable IDs with `gh api "repos/$GH_REPO" --jq '{repository_id: .id, owner_id: .owner.id}'`. Set both IDs in tfvars and leave `enable_service = false`. The trust condition also pins this repository's exact `main` release workflow path; moving repositories requires a reviewed configuration change.

4. Pause releases. Initialize and review the foundation plan privately. Run Terraform commands in `infra/`:

   ```sh
   terraform init -backend-config=backend.hcl -lockfile=readonly
   terraform fmt -check -recursive
   terraform validate
   terraform test
   terraform plan -out=foundation.tfplan
   terraform show foundation.tfplan
   # Engineer review, then apply this same current plan:
   terraform apply foundation.tfplan
   terraform plan -detailed-exitcode
   ```

   This stage creates the registry, APIs, workload identities/federation and project alerts; it creates no Cloud Run service. Exit 0 means no drift, 2 means differences to review, and 1 means an error. Do not apply an old plan after a release or other state change. Verify the project alert budget and create/read back the separate spend cap before service creation; see Billing below.

5. Create the GitHub `development` environment in repository Settings → Environments if absent. Set its three non-secret variables from Terraform outputs (commands from the repository root):

   ```sh
   gh variable set GCP_PROJECT --env development --repo "$GH_REPO" \
     --body "$(terraform -chdir=infra output -raw project_id)"
   gh variable set WORKLOAD_IDENTITY_PROVIDER --env development --repo "$GH_REPO" \
     --body "$(terraform -chdir=infra output -raw workload_identity_provider)"
   gh variable set DEPLOYMENT_SERVICE_ACCOUNT --env development --repo "$GH_REPO" \
     --body "$(terraform -chdir=infra output -raw deployment_service_account)"
   ```

   No Google service-account key belongs in GitHub. The environment must allow the intended `main` release. No additional routine manual release gate is configured by this design.

6. Find successful push-to-main CI and confirm its SHA is still the current main head. Its `api-image-<SHA>` artifact must still exist (retained seven days). Re-enable releases only for the coordinated publish-only step; prevent merges/other dispatches during bootstrap. Set `CI_RUN_ID` to that run:

   ```sh
   gh api "repos/$GH_REPO/commits/main" --jq .sha
   gh run list --repo "$GH_REPO" --workflow ci.yml --branch main \
     --event push --status success --limit 5
   gh workflow enable release.yml --repo "$GH_REPO"
   gh workflow run release.yml --repo "$GH_REPO" --ref main \
     -f ci_run_id="$CI_RUN_ID" -f mode=publish-only -f fail_check=none
   ```

   Identify and watch the dispatched run with `gh run list` and `gh run watch RUN_ID --repo "$GH_REPO" --exit-status`. Inspect its summary. It must verify the checked image, authenticate, and publish successfully; a stale skip is not publication. Record the exact checked SHA and immutable `.../api@sha256:...` from that run. Never rebuild between image verification and deployment or use a placeholder/`latest` image.

7. Pause releases again and drain the queue. Set `enable_service = true`, `bootstrap_commit` and `bootstrap_image` in private tfvars to the checked SHA/digest from publication. Review a fresh plan and apply it. Expect the service and two service IAM memberships; investigate unexpected changes. Verify Ready state, exact `/health`, and the deployed digest. The first service has no previous revision to restore. If unhealthy, retain the failed evidence and repair the configuration/image; do not claim successful bootstrap.

8. Pin 100% traffic explicitly to the verified first revision using the manual-restore command below, and protect that serving image with registry tag `current` before resuming releases. Use the generic tag commands described below. Run a fresh Terraform plan: it must preserve image, release metadata and traffic. Resume releases; dispatch `mode=release` with current checked CI if needed. Keep private bootstrap inputs: lifecycle exclusions let Actions own later release fields without replacing those inputs on every release.

## Inspect health, revisions and logs

```sh
gh run list --repo "$GH_REPO" --workflow release.yml --limit 5
gh run view "$RELEASE_RUN_ID" --repo "$GH_REPO"
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --format='json(status.url,status.traffic,status.latestReadyRevisionName,status.conditions)'
SERVICE_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
gcloud run revisions describe "$REVISION" --project="$PROJECT_ID" --region="$REGION" \
  --format='json(metadata.labels,spec.containers,status.imageDigest,status.conditions)'
```

Take `REVISION`, expected full `EXPECTED_COMMIT`, digest and URLs from the successful workflow summary, then compare them with Google Cloud read-back. The traffic-bearing revision is authoritative; `latestReadyRevisionName` can be a failed-check candidate receiving no normal traffic. Health requires HTTP 200, JSON `status: ok` and the exact full commit:

```sh
node backend/scripts/verify-health.mjs --url "$SERVICE_URL/health" --commit "$EXPECTED_COMMIT"
```

The verifier makes at most 15 attempts with a two-second request timeout and two seconds between attempts. For a candidate, use its exact tagged URL from `status.traffic`/the workflow summary. A tagged URL alone does not imply a share of normal service traffic.

Find service/revision logs in the workflow's Cloud Run logs link or query a bounded interval privately:

```sh
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE AND resource.labels.location=$REGION" \
  --project="$PROJECT_ID" --freshness=1h --limit=50 --format=json
```

Compare startup errors and request failures with the selected revision and deployment timestamp. Before treating an outage as application failure, inspect the spend-cap state below. Cap enforcement is not repaired by rolling back code.

## Manually restore a known revision

1. Pause releases and drain outstanding runs. Inspect actual traffic, then capture the serving revision, full commit, immutable image digest, current/previous registry targets and latest workflow summary privately. Select a retained known-good revision from a successful prior release, not whichever revision happens to be latest. The application is health-only; this procedure restores traffic, not database state or schema.
2. Set `RESTORE_REVISION`, `EXPECTED_COMMIT`, `RESTORE_DIGEST` and `RESTORE_VERSION` (`sha256:...`) from that release. Read back the revision and registry version. Confirm it belongs to this service/project and is Ready, its image matches the digest, and the source label matches the full expected commit. Verify its existing tagged health URL first if one remains.

   ```sh
   gcloud run revisions describe "$RESTORE_REVISION" --project="$PROJECT_ID" --region="$REGION" \
     --format='json(metadata.labels,spec.containers,status.imageDigest,status.conditions)'
   gcloud artifacts versions describe "$RESTORE_VERSION" --project="$PROJECT_ID" \
     --location="$REGION" --repository="$REPOSITORY" --package=api --format=json
   gcloud artifacts tags list --project="$PROJECT_ID" --location="$REGION" \
     --repository="$REPOSITORY" --package=api --format=json
   ```

3. Ensure the image has a `current` or `previous` protection tag before changing traffic. If neither protects it, set `previous` to it while preserving the currently serving image under `current`. For an existing tag use generic `gcloud artifacts tags update TAG --version="$RESTORE_VERSION"`; for an absent tag use `tags create` with the same version and `--project`, `--location`, `--repository`, `--package` flags above. Skip a tag already on the intended version. Read back and check the full returned version. Avoid `gcloud artifacts docker tags add`: the pinned CLI deletes an existing tag before recreating it, unlike the generic update command.
4. Restore explicit traffic, read back the actual allocation, and verify the normal URL:

   ```sh
   gcloud run services update-traffic "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
     --to-revisions="$RESTORE_REVISION=100"
   gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
     --format='json(metadata.generation,status.observedGeneration,status.traffic,status.url)'
   node backend/scripts/verify-health.mjs --url "$SERVICE_URL/health" --commit "$EXPECTED_COMMIT"
   ```

   Require exactly one positive-percentage target, the selected revision at 100%, and observed generation matching metadata generation. Poll read-back up to six times, two seconds apart, for convergence. A failed/timed-out update command does not prove traffic stayed unchanged: inspect actual allocation and health before deciding the next action. If it does not converge or health fails, report the actual state and retain the maintenance window; do not claim recovery or blindly repeat promotion.

5. After verified recovery, reconcile protection tags without leaving either known-good image unprotected. If a fallback would lose its last protection when `current` moves, first create an unused temporary tag with prefix `previous-recovery-` on that fallback version. Then set `current` to the restored image and `previous` to the chosen known-good fallback using generic tag create/update commands. Read both back before deleting only that temporary tag with `gcloud artifacts tags delete TAG` and the same repository flags. If any step fails, retain protection and record the exact targets; temporary protected tags also need eventual cleanup to avoid indefinite retention. Run a private `terraform -chdir=infra plan -detailed-exitcode` and investigate differences rather than applying them during recovery. Record revision/commit/digest, traffic, health, tag targets and any command errors on the issue with sensitive details removed. Decide when normal delivery may resume.

A safe practice drill starts with a captured working revision, selects another retained healthy health-only revision, follows the restore checks, then restores the captured revision and verifies health/tags again. This changes live development traffic: coordinate it explicitly and record both legs. Read-only preflight or a traffic no-op verifies only those portions, not the complete drill.

## Billing controls

Terraform owns the monthly USD 5 project-wide alert budget, including credits, with actual-spend thresholds of 50/90/100%. Default billing administrator/user notifications are enabled. The separate monthly USD 5 Cloud Run cap is engineer-managed outside Terraform because the pinned provider cannot express `spendCap`.

Inspect budgets privately with `gcloud billing budgets list --billing-account="$BILLING_ACCOUNT_ID" --billing-project="$PROJECT_ID" --format=json`. Identify the exact project-scoped alert budget and single-project Cloud Run cap; record their resource names privately. For the cap, read the REST representation, including `spendCap.outputState` and `reconciling`, using the [Billing API instructions](https://docs.cloud.google.com/billing/docs/how-to/budget-api-spend-cap). A user-credential request must include `x-goog-user-project: PROJECT_ID` and OAuth authorization; never log bearer tokens.

For a new cap, first confirm none exists for that project/service. Send the documented JSON **create** request to `POST https://billingbudgets.googleapis.com/v1/billingAccounts/BILLING_ACCOUNT_ID/budgets` with these settings. Get `PROJECT_NUMBER` with `gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)'`. Read the created `name` back with `GET https://billingbudgets.googleapis.com/v1/RESOURCE_NAME`; do not create duplicate controls or overwrite another budget:

| Field                                            | Required value                                      |
| ------------------------------------------------ | --------------------------------------------------- |
| `budgetFilter.projects`                          | One `projects/PROJECT_NUMBER`                       |
| `budgetFilter.services`                          | Cloud Run billing service `services/152E-C115-5142` |
| `budgetFilter.calendarPeriod`                    | `MONTH`                                             |
| `budgetFilter.creditTypesTreatment`              | `EXCLUDE_ALL_CREDITS`                               |
| `amount.specifiedAmount`                         | `currencyCode: USD`, `units: "5"`                   |
| `thresholdRules`                                 | Exactly 0.5, 0.8, 1.0; actual spend                 |
| `notificationsRule.enableProjectLevelRecipients` | `true`                                              |
| `spendCap.inputState`                            | `CONFIGURED`                                        |

Verify `outputState = CONFIGURED` and reconciliation finished before initial deployment. Confirm notification recipients and actual email receipt with the engineer; configuration email receipt is distinct from threshold-alert delivery. Do not deliberately incur spend to trigger an alert.

An `ENFORCED` cap blocks Cloud Run usage. Prefer the monthly reset; lifting it requires an explicit engineer decision. Automation never raises or lifts it. Gross estimated costs can trigger it before net billed costs reach USD 5; enforcement can lag, and registry/storage/other charges remain outside its scope. It is not a total-project charge guarantee. See [cap behavior](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps).

## Retention and private state recovery

| Data                       | Configured retention behavior                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified CI image artifact | Seven days in GitHub Actions; a dispatch requires the artifact still to exist                                                                                   |
| Artifact Registry          | Delete versions older than 14 days unless kept; keep the five newest versions per package and versions tagged with prefixes `current` or `previous`             |
| Terraform state            | Versioning; noncurrent versions eligible for deletion with ten newer versions **or** after 30 noncurrent days; soft-deleted objects retained another seven days |

Keep rules override registry delete rules. These are background cleanup policies, not exact deletion deadlines or a byte/storage-cost ceiling. Protected old images can remain indefinitely. State rules are separate alternatives, not a promise to keep every version for 30 days or exactly ten copies. The current state is not targeted by these rules. See [image cleanup](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) and [storage lifecycle semantics](https://docs.cloud.google.com/storage/docs/lifecycle).

Inspect configuration and protection targets without reading state contents:

```sh
gcloud artifacts repositories describe "$REPOSITORY" --project="$PROJECT_ID" --location="$REGION" \
  --format='json(cleanupPolicies,cleanupPolicyDryRun)'
gcloud artifacts tags list --project="$PROJECT_ID" --location="$REGION" \
  --repository="$REPOSITORY" --package=api --format=json
gcloud storage buckets describe "gs://$STATE_BUCKET" --format=json
gcloud storage ls --all-versions "gs://$STATE_BUCKET/tour-itinerary/dev/default.tfstate"
```

Expect active registry deletion (`cleanupPolicyDryRun` false, which the API may omit), the three Terraform cleanup policies, state location `US-EAST1`, uniform bucket access, enforced public access prevention, versioning, both lifecycle rules, and 604800-second soft delete. Inspect IAM privately after access changes; state permission is only for the engineer, not routine delivery/runtime. Existing project convenience memberships also confer access on project Owners/Editors/Viewers and must be considered when reviewing access.

The [GCS backend](https://developer.hashicorp.com/terraform/language/backend/gcs) supplies Terraform state locking. Do not use `-lock=false` to bypass an active operation. For a stale lock, confirm the recorded owner/process is gone and all writers are stopped; only then use `terraform -chdir=infra force-unlock LOCK_ID` as an engineer-reviewed repair.

For corrupted or accidentally replaced state, pause all writers and preserve the current object generation before repair. List generations with the command above and select a known-good generation after reviewing the state privately. Record the current generation as `CURRENT_GENERATION` and the selected one as `GOOD_GENERATION`. A server-side copy can restore the selected version as the live object, guarded against a concurrent writer:

```sh
gcloud storage cp \
  "gs://$STATE_BUCKET/tour-itinerary/dev/default.tfstate#$GOOD_GENERATION" \
  "gs://$STATE_BUCKET/tour-itinerary/dev/default.tfstate" \
  --if-generation-match="$CURRENT_GENERATION"
```

If there is no live object, use `--if-generation-match=0` after confirming that absence. This copy is a state mutation, not a routine verification command. An older state can omit newer real resources; review lineage/serial and reconcile resource ownership with imports as necessary before any apply. Run a fresh private plan and inspect its differences; restoring state alone does not roll cloud infrastructure back. If the version is already soft-deleted, use the [Cloud Storage recovery procedure](https://docs.cloud.google.com/storage/docs/use-soft-delete) within its recovery window. Do not expose the state in issue comments or public CI artifacts.
