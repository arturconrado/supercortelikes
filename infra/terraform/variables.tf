variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers R2 Storage Write permission."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.cloudflare_api_token) >= 20
    error_message = "cloudflare_api_token must contain a valid Cloudflare API token."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account identifier that owns the R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hexadecimal identifier."
  }
}

variable "r2_bucket_name" {
  description = "Globally unique R2 bucket name used for uploaded and rendered videos."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.r2_bucket_name))
    error_message = "r2_bucket_name must be 3-63 lowercase alphanumeric or hyphen characters."
  }
}

variable "r2_location" {
  description = "Best-effort R2 location hint."
  type        = string
  default     = "enam"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.r2_location)
    error_message = "r2_location must be one of apac, eeur, enam, weur, wnam, or oc."
  }
}

variable "r2_jurisdiction" {
  description = "R2 data jurisdiction."
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.r2_jurisdiction)
    error_message = "r2_jurisdiction must be default, eu, or fedramp."
  }
}

variable "kubeconfig_path" {
  description = "Absolute path to the kubeconfig for the production cluster."
  type        = string

  validation {
    condition     = startswith(var.kubeconfig_path, "/")
    error_message = "kubeconfig_path must be an absolute path."
  }
}

variable "kubeconfig_context" {
  description = "Explicit kubeconfig context for the production cluster."
  type        = string

  validation {
    condition     = length(trimspace(var.kubeconfig_context)) > 0
    error_message = "kubeconfig_context is required to prevent deployment to an unintended cluster."
  }
}

variable "image_repository" {
  description = "Container registry repository for the ClipBR API image."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9.-]+(?::[0-9]+)?/[a-zA-Z0-9_./-]+$", var.image_repository))
    error_message = "image_repository must be a registry-qualified repository."
  }
}

variable "image_tag" {
  description = "Immutable API image tag, normally the full Git commit SHA."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag must be a full 40-character Git commit SHA."
  }
}

variable "migration_image_repository" {
  description = "Container registry repository for the short-lived Prisma migration image."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9.-]+(?::[0-9]+)?/[a-zA-Z0-9_./-]+$", var.migration_image_repository))
    error_message = "migration_image_repository must be a registry-qualified repository."
  }
}

variable "image_pull_secret_names" {
  description = "Existing Kubernetes docker-registry Secret names authorized to pull the private production images."
  type        = list(string)

  validation {
    condition = length(var.image_pull_secret_names) > 0 && alltrue([
      for name in var.image_pull_secret_names : can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", name))
    ])
    error_message = "image_pull_secret_names must contain at least one valid Kubernetes Secret name."
  }
}

variable "application_secret_name" {
  description = "Name of an existing Kubernetes Secret containing DATABASE_URL, REDIS_URL, S3_ACCESS_KEY, and S3_SECRET_KEY."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.application_secret_name))
    error_message = "application_secret_name must be a valid Kubernetes DNS label."
  }
}

variable "database_cidrs" {
  description = "CIDRs that contain the managed PostgreSQL endpoints allowed by NetworkPolicy."
  type        = list(string)

  validation {
    condition     = length(var.database_cidrs) > 0 && alltrue([for cidr in var.database_cidrs : can(cidrnetmask(cidr))])
    error_message = "database_cidrs must contain at least one valid CIDR."
  }
}

variable "redis_cidrs" {
  description = "CIDRs that contain the managed Redis endpoints allowed by NetworkPolicy."
  type        = list(string)

  validation {
    condition     = length(var.redis_cidrs) > 0 && alltrue([for cidr in var.redis_cidrs : can(cidrnetmask(cidr))])
    error_message = "redis_cidrs must contain at least one valid CIDR."
  }
}

variable "object_storage_cidrs" {
  description = "CIDRs that contain the R2 endpoints allowed by NetworkPolicy."
  type        = list(string)

  validation {
    condition     = length(var.object_storage_cidrs) > 0 && alltrue([for cidr in var.object_storage_cidrs : can(cidrnetmask(cidr))])
    error_message = "object_storage_cidrs must contain at least one valid CIDR."
  }
}
