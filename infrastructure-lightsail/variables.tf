variable "aws_region" {
  description = "AWS region for the single-box resources. Lightsail bundle/blueprint ids below are us-east-1 ids."
  type        = string
  default     = "us-east-1"
}

variable "availability_zone" {
  description = "Lightsail AZ for the instance (must be in aws_region)."
  type        = string
  default     = "us-east-1a"
}

# --- The box ----------------------------------------------------------------

variable "instance_name" {
  description = "Lightsail instance name (Aramo go-live #1 box)."
  type        = string
  default     = "astre-aramo-prod"
}

variable "bundle_id" {
  description = "Lightsail bundle (sizing). medium_3_0 = 2 vCPU / 4 GB / 80 GB SSD, dual-stack with a public IPv4 (recon §A.2). The IPv4 matters: the static IP + Route 53 A record are IPv4."
  type        = string
  default     = "medium_3_0"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint. ubuntu_24_04 = a CLEAN Ubuntu 24.04 LTS (recon §A.2) — deliberately NOT the OpenCATS image the existing opencats-astreinc box runs."
  type        = string
  default     = "ubuntu_24_04"
}

# --- SSH key (no private key in state) --------------------------------------

variable "key_pair_name" {
  description = "Name for the Lightsail key pair this root manages."
  type        = string
  default     = "astre-aramo-prod-key"
}

variable "ssh_public_key" {
  description = "The PUBLIC half of the PO's SSH key (ssh-ed25519 / ssh-rsa ...). Importing the public key means Lightsail does NOT generate (and Terraform does NOT store) a private key — no secret in state. Generate the pair out-of-band: `ssh-keygen -t ed25519 -f astre-aramo-prod` and paste the .pub contents here."
  type        = string
}

# --- Firewall ---------------------------------------------------------------

variable "ssh_source_cidr" {
  description = "CIDR allowed to reach SSH (port 22). Restrict to the PO's source IP (e.g. \"203.0.113.7/32\") — NEVER 0.0.0.0/0. 80/443 are open to the world; Postgres/Redis are never opened (container-internal)."
  type        = string
  validation {
    condition     = var.ssh_source_cidr != "0.0.0.0/0" && var.ssh_source_cidr != "::/0"
    error_message = "ssh_source_cidr must not be world-open. Set it to the PO's /32 source IP."
  }
}

# --- DNS --------------------------------------------------------------------

variable "app_fqdn" {
  description = "The FQDN to point at the box (an A record in the aramo.ai zone)."
  type        = string
  default     = "astre.aramo.ai"
}

variable "dns_zone_name" {
  description = "The Route 53 hosted-zone name to create the A record in (recon §A.4: aramo.ai is in this account, public, Z036386539U6ZS64ATYDK)."
  type        = string
  default     = "aramo.ai"
}

variable "dns_record_ttl" {
  description = "TTL (seconds) for the A record. Short, so a box re-IP propagates quickly."
  type        = number
  default     = 300
}

# --- Optional scoped S3-backup IAM (Directive §D) ---------------------------

variable "create_backup_iam_user" {
  description = "If true, provision the s3:PutObject-only IAM user the Directive-3 backup job uses. The ACCESS KEY is NOT created here (it would land in state, §D) — generate it out-of-band after apply (see README §Backup IAM). Default false: opt in deliberately."
  type        = bool
  default     = false
}

variable "backup_iam_user_name" {
  description = "Name for the scoped backup IAM user."
  type        = string
  default     = "astre-aramo-backup-putter"
}

variable "backup_bucket" {
  description = "The backup bucket (the box pg_dump target). Matches BACKUP_S3_URI in the ops runbook (s3://astre-aramo-backups/box/pg)."
  type        = string
  default     = "astre-aramo-backups"
}

variable "backup_prefix" {
  description = "The key prefix under which dumps land. The IAM policy grants PutObject on <prefix>/* and nothing else."
  type        = string
  default     = "box/pg"
}
