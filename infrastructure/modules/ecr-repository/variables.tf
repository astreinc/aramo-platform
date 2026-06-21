variable "name" {
  description = "ECR repository name (e.g. aramo-prod-api). Lowercase; the D1 image is pushed here."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._/-]{1,255}$", var.name))
    error_message = "name must be a valid lowercase ECR repository name."
  }
}

variable "image_tag_mutability" {
  description = "MUTABLE (rolling :latest works) or IMMUTABLE (per-digest tags only; the hardening option)."
  type        = string
  default     = "MUTABLE"

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.image_tag_mutability)
    error_message = "image_tag_mutability must be MUTABLE or IMMUTABLE."
  }
}

variable "image_retention_count" {
  description = "Keep at most this many images in the repository (older ones expire via lifecycle policy)."
  type        = number
  default     = 10
}

variable "untagged_image_retention_count" {
  description = "Keep at most this many untagged images before expiry (lifecycle policy)."
  type        = number
  default     = 2
}

variable "force_delete" {
  description = "Allow `terraform destroy` to remove a repository that still holds images. False in prod (protect the registry)."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
