# M-A8 §1.1.2 — an Aramo-managed KMS key (not AWS-owned) with rotation and an
# EXPLICIT key policy:
#   - the account root ADMINISTERS the key (no data-key or decrypt use);
#   - only the writer and restorer principals USE it, only through S3
#     (kms:ViaService) and only with an encryption context bound to this bucket.
#
# The bucket does NOT enable an S3 Bucket Key (bucket.tf). Without one, S3 passes the
# OBJECT ARN as the encryption context, so each grant below is pinned to the
# prefixes that principal may touch. The cost of one KMS call per object is
# irrelevant at a handful of objects a day.
#
# Every backup object is already age-encrypted on the box to recipients whose
# identities stay offline with the PO; SSE-KMS is the second layer, so nothing in
# AWS can read a backup's content even with this key.

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  s3_via       = "s3.${var.aws_region}.amazonaws.com"

  # Object ARNs per prefix, for the kms:EncryptionContext:aws:s3:arn condition.
  writer_object_arns   = [for p in local.writer_prefixes : "${local.bucket_arn}/${p}*"]
  restorer_read_arns   = [for p in local.restorer_read_prefixes : "${local.bucket_arn}/${p}*"]
  restorer_report_arns = ["${local.bucket_arn}/${local.restore_checks_prefix}*"]
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid    = "AccountRootAdministersTheKey"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
    # Administration only: no Encrypt, Decrypt, ReEncrypt or GenerateDataKey.
    actions = [
      "kms:Create*",
      "kms:Describe*",
      "kms:Enable*",
      "kms:List*",
      "kms:Put*",
      "kms:Update*",
      "kms:Revoke*",
      "kms:Disable*",
      "kms:Get*",
      "kms:Delete*",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
      "kms:RotateKeyOnDemand",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "WriterEncryptsBackupsThroughS3"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.writer.arn]
    }
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = ["*"]
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

  statement {
    sid    = "RestorerDecryptsBackupsThroughS3"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.restorer.arn]
    }
    actions   = ["kms:Decrypt"]
    resources = ["*"]
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

  # The restore-test report upload (§1.1.5 PutObject to restore-checks/) must itself
  # be SSE-KMS under this key (bucket policy, §1.1.4), so S3 needs a data key for it.
  statement {
    sid    = "RestorerEncryptsRestoreReportsThroughS3"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.restorer.arn]
    }
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = ["*"]
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

resource "aws_kms_key" "backups" {
  description             = "Aramo production database backup bucket SSE-KMS (M-A8)"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "backups" {
  name          = var.kms_alias
  target_key_id = aws_kms_key.backups.key_id
}
