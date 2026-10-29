# M-A8 §1.1.2–§1.1.6 — the backup bucket.
#
# Prefixes:
#   routine/<run_id>/        daily + pre-deploy runs (aramo-backup.sh). 30 days.
#   historic/<run_id>/       migrated pre-M-A8 dumps (§1.4 D1). 30 days.
#   historic/env/<…>.age     age-encrypted .env snapshots (§1.2.4). 30 days.
#   heartbeat/<run_id>.json  per-run OK/FAILED marker, counts only. 400 days.
#   restore-checks/<…>.txt   restore-test PASS/FAIL reports, counts only. 400 days.
#   legal-hold/              reserved; deletion denied by policy. No lifecycle rule.
#
# Object Lock is enabled at creation with NO default retention (no
# aws_s3_bucket_object_lock_configuration resource). It exists only so that an
# operator can place a per-object LEGAL HOLD (§1.4). A version under a legal hold
# cannot be deleted by anyone, lifecycle included, until the hold is lifted.
# Enabling Object Lock is IRREVERSIBLE: record it at the apply checkpoint.

locals {
  bucket_arn             = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket_name}"
  writer_prefixes        = ["routine/", "historic/", "heartbeat/"]
  restorer_read_prefixes = ["routine/", "historic/", "legal-hold/"]
  restore_checks_prefix  = "restore-checks/"

  # Forms of "this key" a client may name in x-amz-server-side-encryption-aws-kms-key-id.
  kms_key_id_forms = [
    aws_kms_key.backups.arn,
    aws_kms_key.backups.key_id,
    aws_kms_alias.backups.arn,
    aws_kms_alias.backups.name,
  ]
}

resource "aws_s3_bucket" "backups" {
  bucket              = var.bucket_name
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups.arn
    }
    # Off on purpose: see kms.tf (per-object encryption context = per-prefix grants).
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Versioning must be on before rules reference noncurrent versions.
  depends_on = [aws_s3_bucket_versioning.backups]

  dynamic "rule" {
    for_each = {
      routine          = { prefix = "routine/", days = var.backup_retention_days }
      historic         = { prefix = "historic/", days = var.backup_retention_days }
      heartbeat        = { prefix = "heartbeat/", days = var.report_retention_days }
      "restore-checks" = { prefix = "restore-checks/", days = var.report_retention_days }
    }
    content {
      id     = "${rule.key}-expiry"
      status = "Enabled"
      filter {
        prefix = rule.value.prefix
      }
      expiration {
        days = rule.value.days
      }
      # A version under an Object Lock legal hold is skipped by this rule until the
      # hold is lifted (the documented legal-hold exception, §1.1.6).
      noncurrent_version_expiration {
        noncurrent_days = 1
      }
      abort_incomplete_multipart_upload {
        days_after_initiation = 7
      }
    }
  }

  # Remove the delete markers left once every version under a prefix has expired.
  dynamic "rule" {
    for_each = toset(["routine/", "historic/", "heartbeat/", "restore-checks/"])
    content {
      id     = "${trimsuffix(rule.value, "/")}-delete-markers"
      status = "Enabled"
      filter {
        prefix = rule.value
      }
      expiration {
        expired_object_delete_marker = true
      }
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # §1.1.4 — PutObject must carry SSE-KMS by THIS key. Recon defect 2: a single
  # StringNotEquals on an absent header evaluates true and denies every upload that
  # relies on default encryption. Here each check is split into a Null guard (header
  # absent → deny) and an equality check that only applies when the header is present
  # (Null = false), so a correct upload (aws:kms + this key, sent explicitly by the
  # scripts) matches no Deny. Consequence by design: an UploadPart request carries no
  # SSE header, so multipart uploads are refused; the scripts use single PUTs.
  statement {
    sid    = "DenyPutWithoutSseHeader"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/*"]
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyPutWithNonKmsSse"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/*"]
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyPutWithoutKmsKeyHeader"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/*"]
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyPutWithOtherKmsKey"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/*"]
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = local.kms_key_id_forms
    }
  }

  statement {
    sid    = "DenyLegalHoldPrefixDeletion"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${local.bucket_arn}/legal-hold/*"]
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.bucket.json

  # The public access block must exist first or a policy update can race it.
  depends_on = [aws_s3_bucket_public_access_block.backups]
}
