locals {
  region  = "us-east4"
  service = "tour-itinerary-api"
}

data "google_project" "dev" {}

resource "google_project_service" "api" {
  for_each = toset([
    "artifactregistry.googleapis.com", "run.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "sts.googleapis.com", "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com", "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com", "storage.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "api" {
  location               = local.region
  repository_id          = "tour-itinerary"
  format                 = "DOCKER"
  description            = "Verified development API images; release workflow maintains current/previous tags."
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "old-images"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "1209600s" # 14 days, also protects a candidate during delivery.
    }
  }
  cleanup_policies {
    id     = "rollback-images"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["current", "previous"]
    }
  }
  cleanup_policies {
    id     = "recent-images"
    action = "KEEP"
    most_recent_versions { keep_count = 5 }
  }
  depends_on = [google_project_service.api]
}

resource "google_service_account" "deploy" {
  account_id   = "github-delivery"
  display_name = "Keyless GitHub delivery (no infrastructure access)"
  depends_on   = [google_project_service.api]
}
resource "google_service_account" "runtime" {
  account_id   = "api-runtime"
  display_name = "Health-only API; no application IAM grants"
  depends_on   = [google_project_service.api]
}
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-delivery"
  display_name              = "GitHub delivery"
  depends_on                = [google_project_service.api]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "main-release"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  # workflow_ref is the caller workflow, not a reusable workflow claim.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.repository_id}'",
    "assertion.repository_owner_id == '${var.owner_id}'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.workflow_ref == 'zrm20/tour-itinerary/.github/workflows/release.yml@refs/heads/main'",
    "assertion.event_name in ['workflow_run', 'workflow_dispatch']",
  ])
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "federation" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.repository_id}"
}
resource "google_artifact_registry_repository_iam_member" "writer" {
  location   = local.region
  repository = google_artifact_registry_repository.api.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_service_account_iam_member" "runtime_use" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_billing_budget" "project_alerts" {
  billing_account = var.billing_account
  display_name    = "${var.project_id}: project alerts (not a cap)"
  budget_filter {
    projects               = ["projects/${data.google_project.dev.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = "5"
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }
  # Default billing-admin/user notifications enabled; engineer verifies delivery.
  depends_on = [google_project_service.api]
}

# gcloud waits for regional long-running operations, whose IAM checks are project-scoped.
resource "google_project_iam_custom_role" "delivery_operations" {
  role_id     = "deliveryOperationReader"
  title       = "Delivery operation polling"
  permissions = ["run.operations.get"]
  depends_on  = [google_project_service.api]
}
resource "google_project_iam_member" "delivery_operations" {
  project = var.project_id
  role    = google_project_iam_custom_role.delivery_operations.name
  member  = "serviceAccount:${google_service_account.deploy.email}"
}
