variable "project_id" {
  type        = string
  description = "Dedicated, engineer-owned development project; created outside Terraform."
}
variable "billing_account" {
  type        = string
  description = "Billing account ID, without billingAccounts/ prefix."
}
variable "repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID (not its name)."
  validation {
    condition     = can(regex("^[0-9]+$", var.repository_id))
    error_message = "Use the numeric repository ID returned by GitHub."
  }
}
variable "owner_id" {
  type        = string
  description = "Immutable numeric GitHub owner ID."
  validation {
    condition     = can(regex("^[0-9]+$", var.owner_id))
    error_message = "Use the numeric owner ID returned by GitHub."
  }
}
variable "enable_service" {
  type        = bool
  default     = false
  description = "Enable only after publish-only has produced a verified digest."
}
variable "bootstrap_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Exact verified us-east4 registry digest from publish-only; required for service creation."
}
variable "bootstrap_commit" {
  type        = string
  default     = null
  description = "Full checked main commit matching bootstrap_image."
}

variable "enable_persistence" {
  type        = bool
  default     = false
  description = "Engineer-controlled activation gate; coordinate applies with development delivery. Never disable to bypass a migration failure."
  validation {
    condition = !var.enable_persistence || (
      var.enable_service && var.runtime_database_secret_version != null && var.migration_database_secret_version != null
    )
    error_message = "Activation requires an existing service and both explicit secret versions."
  }
}
variable "runtime_database_secret_version" {
  type        = string
  default     = null
  description = "Explicit positive numeric runtime secret version; no payloads or latest aliases."
  validation {
    condition     = var.runtime_database_secret_version == null ? true : can(regex("^[1-9][0-9]*$", var.runtime_database_secret_version))
    error_message = "Use an explicit positive numeric secret version."
  }
}
variable "migration_database_secret_version" {
  type        = string
  default     = null
  description = "Explicit positive numeric migration secret version; no payloads or latest aliases."
  validation {
    condition     = var.migration_database_secret_version == null ? true : can(regex("^[1-9][0-9]*$", var.migration_database_secret_version))
    error_message = "Use an explicit positive numeric secret version."
  }
}

variable "enable_authentication" {
  type        = bool
  default     = false
  description = "Engineer-controlled activation after migrations and explicit OIDC provisioning."
  validation {
    condition     = !var.enable_authentication || (var.enable_persistence && var.auth_secret_version != null && var.auth_issuer != null)
    error_message = "Authentication requires activated persistence, an issuer and an explicit auth secret version."
  }
}
variable "auth_secret_version" {
  type        = string
  default     = null
  description = "Explicit positive numeric api-auth-secret version; no payload or latest alias."
  validation {
    condition     = var.auth_secret_version == null ? true : can(regex("^[1-9][0-9]*$", var.auth_secret_version))
    error_message = "Use an explicit positive numeric secret version."
  }
}
variable "auth_issuer" {
  type        = string
  default     = null
  description = "Stable normal HTTPS service origin followed by /auth; never a candidate-tag URL."
  validation {
    condition     = var.auth_issuer == null ? true : can(regex("^https://[^/?#@]+/auth$", var.auth_issuer))
    error_message = "Use the stable HTTPS authentication URL ending in /auth."
  }
}
variable "api_audience" {
  type        = string
  default     = "urn:tour-itinerary:api"
  description = "Absolute API resource URI matching explicit OIDC provisioning."
}
variable "access_token_ttl_seconds" {
  type        = number
  default     = 1800
  description = "Access-token lifetime in seconds; initially 30 minutes."
  validation {
    condition     = var.access_token_ttl_seconds >= 1 && var.access_token_ttl_seconds <= 86400 && floor(var.access_token_ttl_seconds) == var.access_token_ttl_seconds
    error_message = "Token lifetime must be an integer from 1 to 86400."
  }
}
