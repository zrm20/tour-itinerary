# Mocked Google API only. No cloud credentials, payloads or real resources.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
override_resource {
  target = google_service_account.runtime
  values = {
    email = "api-runtime@test-project.iam.gserviceaccount.com"
    name  = "projects/test-project/serviceAccounts/api-runtime@test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.deploy
  values = {
    email = "github-delivery@test-project.iam.gserviceaccount.com"
    name  = "projects/test-project/serviceAccounts/github-delivery@test-project.iam.gserviceaccount.com"
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

run "disabled_without_secret_versions" {
  command = apply
  assert {
    condition = (
      google_cloud_run_service.api[0].metadata[0].labels["persistence-mode"] == "disabled" &&
      google_cloud_run_service.api[0].metadata[0].labels["migration-secret-version"] == "disabled" &&
      lookup(google_cloud_run_service.api[0].template[0].metadata[0].labels, "persistence-mode", "") == "disabled" &&
      lookup(google_cloud_run_service.api[0].template[0].metadata[0].labels, "migration-secret-version", "") == "disabled" &&
      length(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env) == 0
    )
    error_message = "Preparation must preserve health-only service without database versions or environment values."
  }
  assert {
    condition = (
      google_secret_manager_secret.runtime_database.secret_id == "api-runtime-database-url" &&
      google_secret_manager_secret.migration_database.secret_id == "api-migration-database-url" &&
      google_secret_manager_secret_iam_member.runtime_database.secret_id == google_secret_manager_secret.runtime_database.id &&
      google_secret_manager_secret_iam_member.runtime_database.member == "serviceAccount:api-runtime@test-project.iam.gserviceaccount.com" &&
      google_secret_manager_secret_iam_member.runtime_database.role == "roles/secretmanager.secretAccessor" &&
      google_secret_manager_secret_iam_member.migration_database.secret_id == google_secret_manager_secret.migration_database.id &&
      google_secret_manager_secret_iam_member.migration_database.member == "serviceAccount:github-delivery@test-project.iam.gserviceaccount.com" &&
      google_secret_manager_secret_iam_member.migration_database.role == "roles/secretmanager.secretAccessor"
    )
    error_message = "Runtime and delivery access must be scoped to their respective individual secrets and distinct identities."
  }
}

run "activation_requires_versions" {
  command = plan
  variables { enable_persistence = true }
  expect_failures = [var.enable_persistence]
}

run "reject_mutable_runtime_version" {
  command = plan
  variables { runtime_database_secret_version = "latest" }
  expect_failures = [var.runtime_database_secret_version]
}

run "reject_mutable_migration_version" {
  command = plan
  variables { migration_database_secret_version = "latest" }
  expect_failures = [var.migration_database_secret_version]
}

run "activated_runtime_reference_only" {
  command = apply
  variables {
    enable_persistence                = true
    runtime_database_secret_version   = "4"
    migration_database_secret_version = "7"
  }
  assert {
    condition = (
      google_cloud_run_service.api[0].metadata[0].labels["persistence-mode"] == "enabled" &&
      google_cloud_run_service.api[0].metadata[0].labels["migration-secret-version"] == "7" &&
      lookup(google_cloud_run_service.api[0].template[0].metadata[0].labels, "persistence-mode", "") == "enabled" &&
      lookup(google_cloud_run_service.api[0].template[0].metadata[0].labels, "migration-secret-version", "") == "7" &&
      length(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env) == 1 &&
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).name == "DATABASE_URL" &&
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).value_from[0].secret_key_ref[0].name == "api-runtime-database-url" &&
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).value_from[0].secret_key_ref[0].key == "4"
    )
    error_message = "Activation must pin only the runtime URL in Cloud Run and expose only the non-secret migration version to delivery."
  }
}

run "prepare_rotated_versions" {
  command = plan
  variables {
    enable_persistence                = true
    runtime_database_secret_version   = "5"
    migration_database_secret_version = "8"
  }
  assert {
    condition = (
      google_cloud_run_service.api[0].metadata[0].labels["migration-secret-version"] == "8" &&
      lookup(google_cloud_run_service.api[0].template[0].metadata[0].labels, "migration-secret-version", "") == "8" &&
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).value_from[0].secret_key_ref[0].key == "5"
    )
    error_message = "Version rotation must remain Terraform-managed rather than ignored with release fields."
  }
}

run "public_editor" {
  command = plan
  variables { graphql_playground = true }
  assert {
    condition = (
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).name == "GRAPHQL_PLAYGROUND" &&
      one(google_cloud_run_service.api[0].template[0].spec[0].containers[0].env).value == "true"
    )
    error_message = "The public editor must not require authentication or database configuration."
  }
}

run "editor_signin_requires_authentication" {
  command = plan
  variables {
    graphql_playground     = true
    graphql_oidc_client_id = "graphiql"
  }
  expect_failures = [var.graphql_oidc_client_id]
}

run "authenticated_editor" {
  command = plan
  variables {
    enable_persistence                = true
    runtime_database_secret_version   = "4"
    migration_database_secret_version = "7"
    enable_authentication             = true
    auth_secret_version               = "1"
    auth_issuer                       = "https://dev.example.test/auth"
    graphql_playground                = true
    graphql_oidc_client_id            = "graphiql"
  }
  assert {
    condition = alltrue([
      for name, value in { GRAPHQL_PLAYGROUND = "true", GRAPHQL_OIDC_CLIENT_ID = "graphiql" } :
      one([for env in google_cloud_run_service.api[0].template[0].spec[0].containers[0].env : env.value if env.name == name]) == value
    ])
    error_message = "The editor must receive its explicit gate and provisioned public client ID."
  }
}
