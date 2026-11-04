# Values and versions are supplied by the engineer directly to Secret Manager.
# Terraform owns containers and individual IAM grants, never secret payloads.
resource "google_secret_manager_secret" "runtime_database" {
  secret_id = "api-runtime-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret" "migration_database" {
  secret_id = "api-migration-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_iam_member" "runtime_database" {
  secret_id = google_secret_manager_secret.runtime_database.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_secret_manager_secret_iam_member" "migration_database" {
  secret_id = google_secret_manager_secret.migration_database.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deploy.email}"
}
