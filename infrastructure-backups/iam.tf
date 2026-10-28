# M-A8 §1.1.5 — least-privilege principals. NO aws_iam_access_key here: a secret
# would land in state (§1.1.8). Keys are created out of band after the apply
# (doc/runbooks/RUNBOOK-backups.md):
#   writer   → /etc/aramo/backup.conf on the box (root:root 0600). Lightsail has no
#              instance role, so the box uses static IAM-user keys.
#   restorer → an AWS profile on the operator Mac.
# There is no legal-hold principal: placing a hold is an operator action with the
# account administrator's credentials on the Mac.

# ── Writer (box) ─────────────────────────────────────────────────────────────
resource "aws_iam_user" "writer" {
  name = var.writer_user_name
}

data "aws_iam_policy_document" "writer" {
  statement {
    sid       = "PutBackupsAndHeartbeats"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [for p in local.writer_prefixes : "${local.bucket_arn}/${p}*"]
  }

  statement {
    sid       = "ListOwnPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [for p in local.writer_prefixes : "${p}*"]
    }
  }

  # No kms:Decrypt: single-PUT uploads only (multipart is refused by the bucket
  # policy, and multipart would be the only reason the writer needed Decrypt).
  statement {
    sid       = "KmsForS3Uploads"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.backups.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = local.writer_object_arns
    }
  }
}

resource "aws_iam_user_policy" "writer" {
  name   = "db-backups-put-list-only"
  user   = aws_iam_user.writer.name
  policy = data.aws_iam_policy_document.writer.json
}

# ── Restorer (operator Mac) ──────────────────────────────────────────────────
resource "aws_iam_user" "restorer" {
  name = var.restorer_user_name
}

data "aws_iam_policy_document" "restorer" {
  statement {
    sid       = "ReadBackups"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = [for p in local.restorer_read_prefixes : "${local.bucket_arn}/${p}*"]
  }

  statement {
    sid       = "ListBackups"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
  }

  statement {
    sid       = "WriteRestoreReports"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/${local.restore_checks_prefix}*"]
  }

  statement {
    sid       = "KmsDecryptBackupsThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.backups.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = local.restorer_read_arns
    }
  }

  statement {
    sid       = "KmsEncryptRestoreReportsThroughS3"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.backups.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = local.restorer_report_arns
    }
  }
}

resource "aws_iam_user_policy" "restorer" {
  name   = "db-backups-restore-read"
  user   = aws_iam_user.restorer.name
  policy = data.aws_iam_policy_document.restorer.json
}
