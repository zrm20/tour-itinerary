terraform {
  required_version = "= 1.17.1"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = "us-east4"
  # Billing Budgets requires an explicit quota project with user ADCs.
  billing_project       = var.project_id
  user_project_override = true
}
