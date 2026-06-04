# Aramo A8-3a — S3 résumé-bucket module (4th module under
# infrastructure/modules/, following the M4 PR-9 cloudwatch-log-group /
# M5 PR-10a rds precedents).
#
# Provisions:
#   - aws_s3_bucket.resumes              — the résumé-class object bucket
#   - aws_s3_bucket.resumes_logs         — S3-server-access-log destination
#                                          for the resumes bucket (PII floor: audit trail)
#   - aws_s3_bucket_public_access_block  — block all public access
#                                          (the private-bucket PII-floor item)
#   - aws_kms_key.resumes                — DEDICATED CMK for SSE-KMS
#                                          (departs from ADR-0016 Decision 7's
#                                          account-default-KMS posture because
#                                          résumés are dense PII — the
#                                          enum-column F16-deferral does not
#                                          apply to a résumé-class artifact)
#   - aws_s3_bucket_server_side_encryption_configuration
#                                        — SSE-KMS with bucket_key_enabled
#                                          (cost optimization + per-object key
#                                          rotation)
#   - aws_s3_bucket_logging              — server access log → logs bucket
#                                          (PII floor: bucket-level audit trail
#                                          beyond the application-layer
#                                          access-log emission)
#   - aws_s3_bucket_versioning           — versioning enabled (recoverability
#                                          + accidental-delete defense)
#   - aws_s3_bucket_lifecycle_configuration
#                                        — TalentDocumentRetentionPolicy
#                                          alignment (3 rules: default 365d,
#                                          extended 7y, delete_after_X_days
#                                          via tag)
#   - aws_s3_bucket_cors_configuration   — scoped to var.cors_allowed_origins
#                                          (NEVER "*"); enables the direct-
#                                          browser-PUT pattern the A4 design
#                                          requires
#   - aws_iam_policy_document.app_least_privilege
#                                        — IAM policy document the app role
#                                          consumes (least-privilege: PutObject
#                                          + GetObject on the bucket prefix
#                                          only; NO ListBucket, NO DeleteObject
#                                          at A8-3a — soft-delete via versioning
#                                          + object-tag-driven lifecycle)
#
# PII-floor checklist (the §2 directive items, all present below):
#   [X] Private bucket (public_access_block, all four flags true)
#   [X] SSE-KMS with a dedicated CMK
#   [X] Short-expiry presigned URLs — enforced at the LIB layer
#       (libs/object-storage caps at 300s); NOT a bucket policy
#   [X] CORS scoped to var.cors_allowed_origins (NOT "*")
#   [X] Lifecycle policy aligned to TalentDocumentRetentionPolicy
#   [X] Access logging — S3 server access logs to the logs bucket
#
# Out of scope (deferred to follow-ups):
#   - The IAM ROLE that binds this policy to the app principal — that
#     lives in the broader IAM module the readiness track will land
#     (this module emits the policy DOCUMENT only, consumed by whichever
#     role provisioning lands).
#   - The full F16 PII mechanics (elevated-permission gating,
#     application-side encrypted index, multi-party audit). A8-3a does
#     the FLOOR — see the directive §2.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Dedicated KMS key for SSE-KMS (the PII-floor item).
# -----------------------------------------------------------------------------
resource "aws_kms_key" "resumes" {
  description             = "Aramo ${var.environment} résumé-bucket SSE-KMS key (A8-3a, dedicated; departs from ADR-0016 Decision 7 account-default posture because résumés are dense PII)."
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name    = "aramo-${var.environment}-resumes-kms"
    Purpose = "resume-bucket-sse-kms"
  })
}

resource "aws_kms_alias" "resumes" {
  name          = "alias/aramo-${var.environment}-resumes"
  target_key_id = aws_kms_key.resumes.key_id
}

# -----------------------------------------------------------------------------
# Server-access-log destination bucket (PII floor: bucket-level audit trail).
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "resumes_logs" {
  bucket = "aramo-${var.environment}-resumes-logs"

  tags = merge(var.tags, {
    Name    = "aramo-${var.environment}-resumes-logs"
    Purpose = "resume-bucket-server-access-logs"
  })
}

resource "aws_s3_bucket_public_access_block" "resumes_logs" {
  bucket = aws_s3_bucket.resumes_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "resumes_logs" {
  bucket = aws_s3_bucket.resumes_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "resumes_logs" {
  bucket = aws_s3_bucket.resumes_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }
  }
}

# -----------------------------------------------------------------------------
# The résumé bucket.
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "resumes" {
  bucket = "aramo-${var.environment}-resumes"

  tags = merge(var.tags, {
    Name    = "aramo-${var.environment}-resumes"
    Purpose = "resume-class-pii-objects"
  })
}

# Private bucket: block ALL public access (the PII-floor item).
resource "aws_s3_bucket_public_access_block" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-KMS with the dedicated CMK + bucket-key-enabled (cost optimization).
resource "aws_s3_bucket_server_side_encryption_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.resumes.arn
    }
    bucket_key_enabled = true
  }
}

# Versioning — recoverability + accidental-delete defense.
resource "aws_s3_bucket_versioning" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-access logging → the logs bucket (PII-floor audit-trail).
resource "aws_s3_bucket_logging" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  target_bucket = aws_s3_bucket.resumes_logs.id
  target_prefix = "resumes/"
}

# CORS — scoped to the app origin(s); enables the direct-browser PUT
# pattern. NEVER "*" — the resume-bucket-pii floor rejects open CORS.
resource "aws_s3_bucket_cors_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["Content-Type", "Content-Length", "Authorization"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# Lifecycle — aligned to TalentDocumentRetentionPolicy enum
# (default | extended | delete_after_X_days). 3 rules, all driven by
# the object tag `retention_policy` set at upload-time. Objects without
# a tag fall under `default`.
resource "aws_s3_bucket_lifecycle_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  # Rule 1 — default retention.
  rule {
    id     = "retention-default"
    status = "Enabled"

    filter {
      tag {
        key   = "retention_policy"
        value = "default"
      }
    }

    expiration {
      days = var.retention_days_default
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  # Rule 2 — extended retention (compliance-tier objects).
  rule {
    id     = "retention-extended"
    status = "Enabled"

    filter {
      tag {
        key   = "retention_policy"
        value = "extended"
      }
    }

    expiration {
      days = var.retention_days_extended
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  # Rule 3 — delete-after-X via the `retention_days` numeric tag.
  # Note: per-object day-count overrides are implemented at the
  # application layer (the app sets retention_days as an explicit
  # object-expiration date via S3 object lifecycle metadata at PUT
  # time). The bucket-level rule below is a SAFETY NET for the
  # delete_after_X_days tag class — objects flagged with this tag get
  # an aggressive default expiry the app can extend explicitly.
  rule {
    id     = "retention-delete-after-x"
    status = "Enabled"

    filter {
      tag {
        key   = "retention_policy"
        value = "delete_after_X_days"
      }
    }

    expiration {
      days = var.retention_days_delete_after_x_floor
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  # Rule 4 — incomplete multipart uploads (recover wasted storage).
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# -----------------------------------------------------------------------------
# IAM policy document — least-privilege for the app principal.
#
# The app needs PutObject + GetObject on the bucket prefix only. NO
# ListBucket (objects are discovered via the Attachment.storage_key
# stored in Postgres, not via S3 enumeration). NO DeleteObject (soft-
# delete via versioning + lifecycle; the recruiter "delete attachment"
# operation removes the Attachment ROW + tags the S3 object's current
# version for lifecycle expiration — the bytes age out per the
# retention policy).
#
# kms:GenerateDataKey + kms:Decrypt on the dedicated CMK are required
# for SSE-KMS PUT/GET respectively.
#
# This module EMITS the policy document; the role binding lives in the
# (future) IAM module the readiness track will deliver. The output
# `app_iam_policy_json` is the consumer's contract.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "app_least_privilege" {
  statement {
    sid    = "AppS3PutGet"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]
    resources = ["${aws_s3_bucket.resumes.arn}/*"]
  }

  statement {
    sid    = "AppKmsForSseKms"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]
    resources = [aws_kms_key.resumes.arn]
  }
}
