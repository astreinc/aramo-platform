# M-A7 §2 / R-15 — encrypted, off-server database backups. AUTHORED, NOT
# APPLIED. Terraform is applied ONLY from the Mac (the box hits the wrong AWS
# account / 403 on the state bucket). Gated by var.manage_r15_backups (default
# false) so an unrelated apply of this root never creates it by accident.
#
# Layers (defence in depth):
#   1. client-side: every object is already age-encrypted on the box to public
#      recipients whose private keys stay offline with the PO
#      (deploy/backup/aramo-backup.sh); nothing in AWS can decrypt it;
#   2. server-side: SSE-KMS with a dedicated symmetric key (rotation on) and an
#      S3 Bucket Key;
#   3. access: public access fully blocked, ACLs disabled (BucketOwnerEnforced),
#      TLS-only bucket policy, two least-privilege IAM users (no access keys in
#      state — generate them out-of-band, same rule as the legacy backup user).
#
# Prefixes and retention:
#   routine/<run_id>/     deploy + scheduled backups. Expire after
#                         var.r15_routine_retention_days (30, the M-A7 §2
#                         baseline); noncurrent versions after 1 day.
#   historic/<run_id>/    the encrypted copies of the pre-R-15 plaintext dumps
#                         (migration only). Expiry var.r15_historic_retention_days
#                         — a PO decision, recorded in the R-15 plan.
#   legal-hold/<ref>/     exceptional preservation under a DOCUMENTED legal or
#                         security hold. No lifecycle rule; the bucket policy
#                         denies object deletion for every principal, so releasing
#                         a hold is a reviewed change to this file, applied from
#                         the Mac.
#
# Object Lock: off by default (var.r15_object_lock_enabled). It can only be set
# at bucket creation and can never be turned off. The deletion promise in M-A7
# §3 means routine copies must be able to expire, and the legal-hold prefix is
# already protected by the deny-delete policy; Object Lock legal holds would add
# protection against an AWS-admin-level actor at the cost of irreversibility.
# Enable it only on a PO / counsel decision before the first apply.

variable "manage_r15_backups" {
  description = "If true, create the R-15 encrypted backup bucket, its KMS key, lifecycle, policy and the writer/restorer IAM users. Default false: opt in deliberately (apply from the Mac only)."
  type        = bool
  default     = false
}

variable "r15_backup_bucket" {
  description = "Name of the R-15 backup bucket (matches BACKUP_S3_URI on the box)."
  type        = string
  default     = "aramo-prod-db-backups-use1"
}

variable "r15_routine_retention_days" {
  description = "Days before routine/ backups expire (M-A7 §2 baseline: 30)."
  type        = number
  default     = 30
}

variable "r15_historic_retention_days" {
  description = "Days before historic/ (migrated pre-R-15 dumps) expire. PO decision; defaults to the 30-day baseline."
  type        = number
  default     = 30
}

variable "r15_object_lock_enabled" {
  description = "Enable S3 Object Lock at bucket creation (irreversible). Default false; see the header comment."
  type        = bool
  default     = false
}

variable "r15_writer_user_name" {
  description = "IAM user the box uses to upload backups (put + list only)."
  type        = string
  default     = "aramo-prod-backup-writer"
}

variable "r15_restorer_user_name" {
  description = "IAM user the operator Mac uses for restore tests (read only)."
  type        = string
  default     = "aramo-prod-backup-restorer"
}

locals {
  r15         = var.manage_r15_backups ? 1 : 0
  r15_bucket  = "arn:aws:s3:::${var.r15_backup_bucket}"
  r15_kms_via = "s3.${var.aws_region}.amazonaws.com"
}

# ── KMS key for SSE-KMS ───────────────────────────────────────────────────────
resource "aws_kms_key" "r15_backups" {
  count                   = local.r15
  description             = "Aramo R-15 database backup bucket SSE-KMS"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "r15_backups" {
  count         = local.r15
  name          = "alias/aramo-prod-db-backups"
  target_key_id = aws_kms_key.r15_backups[0].key_id
}

# ── Bucket ────────────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "r15_backups" {
  count               = local.r15
  bucket              = var.r15_backup_bucket
  object_lock_enabled = var.r15_object_lock_enabled

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "r15_backups" {
  count  = local.r15
  bucket = aws_s3_bucket.r15_backups[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "r15_backups" {
  count                   = local.r15
  bucket                  = aws_s3_bucket.r15_backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "r15_backups" {
  count  = local.r15
  bucket = aws_s3_bucket.r15_backups[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "r15_backups" {
  count  = local.r15
  bucket = aws_s3_bucket.r15_backups[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.r15_backups[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "r15_backups" {
  count  = local.r15
  bucket = aws_s3_bucket.r15_backups[0].id

  # Versioning must be on before lifecycle rules reference noncurrent versions.
  depends_on = [aws_s3_bucket_versioning.r15_backups]

  rule {
    id     = "routine-expiry"
    status = "Enabled"
    filter {
      prefix = "routine/"
    }
    expiration {
      days = var.r15_routine_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "historic-expiry"
    status = "Enabled"
    filter {
      prefix = "historic/"
    }
    expiration {
      days = var.r15_historic_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Clean up delete markers left once every version under routine/ or
  # historic/ has expired. legal-hold/ has no rule at all.
  rule {
    id     = "expired-delete-markers"
    status = "Enabled"
    filter {
      prefix = "routine/"
    }
    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "expired-delete-markers-historic"
    status = "Enabled"
    filter {
      prefix = "historic/"
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
}

resource "aws_s3_bucket_policy" "r15_backups" {
  count  = local.r15
  bucket = aws_s3_bucket.r15_backups[0].id

  # The public access block must exist first or a policy update can race it.
  depends_on = [aws_s3_bucket_public_access_block.r15_backups]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.r15_bucket, "${local.r15_bucket}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        # Default encryption already applies SSE-KMS when no header is sent;
        # this denies an explicit request for any OTHER server-side mode.
        Sid       = "DenyNonKmsUploads"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.r15_bucket}/*"
        Condition = {
          StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
        }
      },
      {
        # Exceptional preservation (M-A7 §2): nobody deletes a held object.
        # Releasing a hold = a reviewed change to this statement, applied
        # from the Mac. Lifecycle never touches legal-hold/ (no rule).
        Sid       = "DenyLegalHoldDeletion"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${local.r15_bucket}/legal-hold/*"
      },
    ]
  })
}

# ── IAM: the box's writer (put + list only; no read, no delete) ───────────────
# No aws_iam_access_key: its secret would land in state. Generate out-of-band:
#   aws iam create-access-key --user-name aramo-prod-backup-writer
# and place it in /etc/aramo/backup.conf (root:root 0600) on the box.
resource "aws_iam_user" "r15_writer" {
  count = local.r15
  name  = var.r15_writer_user_name
}

resource "aws_iam_user_policy" "r15_writer" {
  count = local.r15
  name  = "r15-backup-put-list-only"
  user  = aws_iam_user.r15_writer[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PutRoutineAndHistoric"
        Effect = "Allow"
        Action = "s3:PutObject"
        Resource = [
          "${local.r15_bucket}/routine/*",
          "${local.r15_bucket}/historic/*",
        ]
      },
      {
        Sid       = "ListOwnPrefixes"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = local.r15_bucket
        Condition = { StringLike = { "s3:prefix" = ["routine/*", "historic/*"] } }
      },
      {
        # SSE-KMS PutObject needs GenerateDataKey; multipart uploads (the CLI
        # uses them above 8 MB) also need Decrypt. Scoped to S3 use of this
        # bucket only. The writer has no s3:GetObject, and objects are
        # age-encrypted anyway, so this grants no read of backup content.
        Sid      = "KmsForS3Uploads"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = aws_kms_key.r15_backups[0].arn
        Condition = {
          StringEquals = { "kms:ViaService" = local.r15_kms_via }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = "${local.r15_bucket}*" }
        }
      },
    ]
  })
}

# ── IAM: the restore-test reader (operator Mac; read only) ────────────────────
resource "aws_iam_user" "r15_restorer" {
  count = local.r15
  name  = var.r15_restorer_user_name
}

resource "aws_iam_user_policy" "r15_restorer" {
  count = local.r15
  name  = "r15-backup-read-only"
  user  = aws_iam_user.r15_restorer[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadBackups"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${local.r15_bucket}/*"
      },
      {
        Sid      = "ListBackups"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:ListBucketVersions"]
        Resource = local.r15_bucket
      },
      {
        Sid      = "KmsForS3Reads"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = aws_kms_key.r15_backups[0].arn
        Condition = {
          StringEquals = { "kms:ViaService" = local.r15_kms_via }
        }
      },
    ]
  })
}

output "r15_backup_bucket" {
  description = "BACKUP_S3_URI bucket for deploy/backup/aramo-backup.sh (null until manage_r15_backups)."
  value       = var.manage_r15_backups ? "s3://${aws_s3_bucket.r15_backups[0].bucket}" : null
}

output "r15_backup_kms_key_arn" {
  description = "SSE-KMS key of the R-15 backup bucket."
  value       = var.manage_r15_backups ? aws_kms_key.r15_backups[0].arn : null
}
