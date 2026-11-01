# Synthetic remote state after Actions delivery, with deliberate ordinary drift.
# Used only with the test's mocked Google provider.
resource "google_cloud_run_service" "api" {
  count                      = 1
  name                       = "tour-itinerary-api"
  location                   = "us-east4"
  autogenerate_revision_name = true
  metadata {
    labels = { "source-commit" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "release-id" = "r123-1" }
    annotations = {
      "run.googleapis.com/ingress"  = "all"
      "run.googleapis.com/minScale" = "0"
      "run.googleapis.com/maxScale" = "7" # Ordinary drift: plan must restore 2.
    }
  }
  template {
    metadata {
      labels = { "source-commit" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "release-id" = "r123-1" }
    }
    spec {
      timeout_seconds = 99 # Ordinary drift: plan must restore 30.
      containers {
        image = "us-east4-docker.pkg.dev/test-project/tour-itinerary/api@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      }
    }
  }
  traffic {
    revision_name   = "tour-itinerary-api-current"
    latest_revision = false
    percent         = 100
  }
  traffic {
    revision_name   = "tour-itinerary-api-next"
    latest_revision = false
    percent         = 0
    tag             = "candidate-123-1"
  }
}
