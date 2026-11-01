# Model Cloud Run's effective annotations, including defaults omitted by the API.
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
  project_id       = "test-project"
  billing_account  = "000000-000000-000000"
  repository_id    = "123456789"
  owner_id         = "71274676"
  enable_service   = true
  bootstrap_image  = "us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  bootstrap_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "api_omits_default_service_minimum" {
  command   = apply
  state_key = "omitted-minimum"

  override_resource {
    target = google_cloud_run_service.api[0]
    values = {
      metadata = { effective_annotations = { "run.googleapis.com/maxScale" = "2" } }
    }
  }

  assert {
    condition = (
      !contains(keys(google_cloud_run_service.api[0].metadata[0].annotations), "run.googleapis.com/minScale") &&
      google_cloud_run_service.api[0].template[0].metadata[0].annotations["autoscaling.knative.dev/minScale"] == "0"
    )
    error_message = "Use the API's omitted service minimum default while retaining revision minimum zero."
  }
}

run "api_returns_explicit_zero_minimum" {
  command   = apply
  state_key = "explicit-zero-minimum"

  override_resource {
    target = google_cloud_run_service.api[0]
    values = {
      metadata = { effective_annotations = { "run.googleapis.com/minScale" = "0" } }
    }
  }
}

run "reject_positive_service_minimum" {
  command   = apply
  state_key = "positive-minimum"

  override_resource {
    target = google_cloud_run_service.api[0]
    values = {
      metadata = { effective_annotations = { "run.googleapis.com/minScale" = "3" } }
    }
  }

  expect_failures = [google_cloud_run_service.api[0]]
}
