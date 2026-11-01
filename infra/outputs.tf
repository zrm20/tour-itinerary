output "project_id" { value = var.project_id }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deployment_service_account" { value = google_service_account.deploy.email }
output "image_repository" { value = "us-east4-docker.pkg.dev/${var.project_id}/tour-itinerary/api" }
output "service_name" { value = local.service }
output "service_url" { value = try(google_cloud_run_service.api[0].status[0].url, null) }
