variable "name" {
  description = "IAM user name for the certbot DNS-01 principal."
  type        = string
  default     = "aramo-certbot-dns"

  validation {
    condition     = length(var.name) > 0 && length(var.name) <= 64
    error_message = "name must be 1–64 characters (IAM user name limit)."
  }
}

variable "zone_id" {
  description = "The aramo.ai hosted-zone id (passed from route53-apex.zone_id). Scopes the ChangeResourceRecordSets statement to this zone's ARN."
  type        = string
}

variable "record_name" {
  description = "The one record name the principal may write — the ACME DNS-01 challenge TXT. The wildcard SAN and the apex share this name."
  type        = string
  default     = "_acme-challenge.aramo.ai"
}

variable "tags" {
  description = "Tags merged onto the IAM user (provider default_tags already apply Project/Environment/ManagedBy)."
  type        = map(string)
  default     = {}
}
