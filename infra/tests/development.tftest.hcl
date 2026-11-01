# Only mocked providers: never credentials, real resources, or remote state.
mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/test-project/serviceAccounts/test-account@test-project.iam.gserviceaccount.com"
      email = "test-account@test-project.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
variables {
  project_id      = "test-project"
  billing_account = "000000-000000-000000"
  repository_id   = "123456789"
  owner_id        = "71274676"
}

run "foundation_before_first_image" {
  command = plan
  assert {
    condition     = length(google_cloud_run_service.api) == 0
    error_message = "Foundation must not create a service or require a placeholder image."
  }
  assert {
    condition = google_iam_workload_identity_pool_provider.github.attribute_condition == join(" && ", [
      "assertion.repository_id == '123456789'",
      "assertion.repository_owner_id == '71274676'",
      "assertion.ref == 'refs/heads/main'",
      "assertion.workflow_ref == 'zrm20/tour-itinerary/.github/workflows/release.yml@refs/heads/main'",
      "assertion.event_name in ['workflow_run', 'workflow_dispatch']",
    ])
    error_message = "Federation must restrict immutable repo/owner, main, intended workflow and non-PR event."
  }
  assert {
    condition     = google_billing_budget.project_alerts.amount[0].specified_amount[0].units == "5" && toset([for t in google_billing_budget.project_alerts.threshold_rules : t.threshold_percent]) == toset([0.5, 0.9, 1.0])
    error_message = "Project alerts must be $5 with 50/90/100% thresholds."
  }
}

run "service_requires_verified_digest" {
  command = plan
  variables {
    enable_service   = true
    bootstrap_image  = "placeholder:latest"
    bootstrap_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [google_cloud_run_service.api[0]]
}

run "create_verified_service" {
  command = apply
  variables {
    enable_service   = true
    bootstrap_image  = "us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    bootstrap_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = (
      google_cloud_run_service.api[0].template[0].spec[0].containers[0].resources[0].limits == tomap({ cpu = "1", memory = "512Mi" }) &&
      google_cloud_run_service.api[0].template[0].metadata[0].annotations["run.googleapis.com/cpu-throttling"] == "true" &&
      google_cloud_run_service.api[0].metadata[0].annotations["run.googleapis.com/minScale"] == "0" &&
      google_cloud_run_service.api[0].metadata[0].annotations["run.googleapis.com/maxScale"] == "2" &&
      google_cloud_run_service.api[0].template[0].spec[0].containers[0].startup_probe[0].http_get[0].path == "/health"
    )
    error_message = "Keep request billing, 0/2 scaling, 1 CPU/512Mi, and HTTP startup health."
  }
}

run "seed_external_release" {
  command   = apply
  state_key = "ownership"
  module { source = "./tests/released-service" }
}

run "preserve_release_owned_fields" {
  command   = plan
  state_key = "ownership"
  variables {
    enable_service   = true
    bootstrap_image  = "us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    bootstrap_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = (
      google_cloud_run_service.api[0].template[0].spec[0].containers[0].image == "us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:2222222222222222222222222222222222222222222222222222222222222222" &&
      google_cloud_run_service.api[0].template[0].metadata[0].labels["source-commit"] == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" &&
      google_cloud_run_service.api[0].metadata[0].labels["release-id"] == "r123-1" &&
      google_cloud_run_service.api[0].traffic[0].revision_name == "tour-itinerary-api-current" &&
      google_cloud_run_service.api[0].traffic[0].percent == 100 &&
      google_cloud_run_service.api[0].traffic[1].tag == "candidate-123-1" &&
      google_cloud_run_service.api[0].traffic[1].percent == 0
    )
    error_message = "Plans must preserve externally released digest, metadata and traffic/tags."
  }
  assert {
    condition = (
      google_cloud_run_service.api[0].template[0].spec[0].timeout_seconds == 30 &&
      google_cloud_run_service.api[0].metadata[0].annotations["run.googleapis.com/maxScale"] == "2"
    )
    error_message = "Ordinary timeout/scaling drift must remain managed despite release exclusions."
  }
}
