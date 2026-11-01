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
