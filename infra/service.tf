# v1 resource intentionally: autogenerate_revision_name omits the old immutable
# revision name on infrastructure updates, even though delivery owns that name.
resource "google_cloud_run_service" "api" {
  count                      = var.enable_service ? 1 : 0
  name                       = local.service
  location                   = local.region
  autogenerate_revision_name = true
  deletion_policy            = "DELETE" # Disposable development environment.
  metadata {
    annotations = {
      "run.googleapis.com/ingress"  = "all"
      "run.googleapis.com/minScale" = "0"
      "run.googleapis.com/maxScale" = "2"
    }
  }
  template {
    metadata {
      labels = { "source-commit" = var.bootstrap_commit, "release-id" = "bootstrap" }
      annotations = {
        "autoscaling.knative.dev/minScale"     = "0"
        "autoscaling.knative.dev/maxScale"     = "2"
        "run.googleapis.com/cpu-throttling"    = "true"
        "run.googleapis.com/startup-cpu-boost" = "false"
      }
    }
    spec {
      service_account_name  = google_service_account.runtime.email
      timeout_seconds       = 30
      container_concurrency = 80
      containers {
        image = var.bootstrap_image
        ports { container_port = 8080 }
        resources { limits = { cpu = "1", memory = "512Mi" } }
        startup_probe {
          initial_delay_seconds = 0
          timeout_seconds       = 2
          period_seconds        = 3
          failure_threshold     = 20
          http_get {
            path = "/health"
            port = 8080
          }
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = can(regex("^us-east4-docker[.]pkg[.]dev/${var.project_id}/tour-itinerary/api@sha256:[0-9a-f]{64}$", var.bootstrap_image))
      error_message = "Service creation requires the verified publish-only registry digest."
    }
    precondition {
      condition     = can(regex("^[0-9a-f]{40}$", var.bootstrap_commit))
      error_message = "Service creation requires the checked bootstrap commit."
    }
    # Only application-release metadata, revision identity and routing are ignored.
    ignore_changes = [
      template[0].spec[0].containers[0].image,
      template[0].metadata[0].name,
      template[0].metadata[0].labels["source-commit"],
      template[0].metadata[0].labels["release-id"],
      metadata[0].labels["source-commit"],
      metadata[0].labels["release-id"],
      # gcloud release-tool metadata; no ordinary configuration is excluded.
      metadata[0].annotations["run.googleapis.com/client-name"],
      metadata[0].annotations["run.googleapis.com/client-version"],
      template[0].metadata[0].annotations["run.googleapis.com/client-name"],
      template[0].metadata[0].annotations["run.googleapis.com/client-version"],
      traffic,
    ]
  }
  depends_on = [google_project_service.api]
}
resource "google_cloud_run_service_iam_member" "public" {
  count    = var.enable_service ? 1 : 0
  location = local.region
  service  = google_cloud_run_service.api[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_run_service_iam_member" "deployer" {
  count    = var.enable_service ? 1 : 0
  location = local.region
  service  = google_cloud_run_service.api[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deploy.email}"
}
