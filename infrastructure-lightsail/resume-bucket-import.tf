# Aramo Sign Executed-Artifact Custody and Isolation Directive v1.0 (LOCKED), SX-3:
#   RM-5  enable rotation on alias/aramo-prod-resumes-key;
#   RM-6  a Terraform IMPORT plan (no apply) for aramo-prod-resumes-use1 and
#         aramo-api-prod-policy, matching live values. The unapplied
#         infrastructure/modules/s3-resume-bucket lifecycle rules are NOT adopted;
#   RM-3  on the résumé bucket, a Deny on version deletion and configuration
#         changes, as in SX-2 item 2 (separate reviewed change).
#
# AUTHORED, NOT APPLIED. Every block below was written against live values read
# 2026-10-29 with read-only get-* calls. The ONLY intended differences from live:
#   - aws_kms_key.resumes:    enable_key_rotation false -> true (RM-5);
#   - aws_s3_bucket_policy.resumes: one added Deny statement (RM-3), the existing
#     TLS-only Deny kept byte-for-byte.
#
# The bucket resource itself (aws_s3_bucket) and the key alias are deliberately not
# imported: managing the sub-configurations is enough, and the CORS rule already
# lives in resume-bucket-cors.tf.
#
# The imported KMS key and IAM policy use the `untagged` provider (provider.tf):
# they carry no tags live, and the root's default_tags would otherwise add three.

locals {
  resumes_bucket_name = "aramo-prod-resumes-use1"
  resumes_bucket_arn  = "arn:aws:s3:::${local.resumes_bucket_name}"
  resumes_kms_key_id  = "ea53f8d5-50e9-409a-9ab8-f5bc92bdfd89"
  resumes_kms_key_arn = "arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key/${local.resumes_kms_key_id}"
  resumes_api_user    = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:user/${var.api_iam_user_name}"
  resumes_key_admin   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:user/purush"
}

# ── Import blocks (Terraform >= 1.5 config-driven import) ───────────────────────
import {
  to = aws_kms_key.resumes
  id = local.resumes_kms_key_id
}

import {
  to = aws_s3_bucket_versioning.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_s3_bucket_public_access_block.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_s3_bucket_ownership_controls.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_s3_bucket_policy.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_s3_bucket_lifecycle_configuration.resumes
  id = local.resumes_bucket_name
}

import {
  to = aws_iam_policy.api_prod
  id = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/aramo-api-prod-policy"
}

# ── Résumé key (RM-5) ───────────────────────────────────────────────────────────
# Key policy = the live console policy, unchanged (Id key-consolepolicy-3).
resource "aws_kms_key" "resumes" {
  provider = aws.untagged

  enable_key_rotation = true # RM-5: the one approved change (live: false)

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "key-consolepolicy-3"
    Statement = [
      {
        Sid       = "Enable IAM User Permissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "Allow access for Key Administrators"
        Effect    = "Allow"
        Principal = { AWS = local.resumes_key_admin }
        Action    = local.kms_admin_actions
        Resource  = "*"
      },
      {
        Sid       = "Allow use of the key"
        Effect    = "Allow"
        Principal = { AWS = [local.resumes_key_admin, local.resumes_api_user] }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
      {
        Sid       = "Allow attachment of persistent resources"
        Effect    = "Allow"
        Principal = { AWS = [local.resumes_key_admin, local.resumes_api_user] }
        Action    = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

# ── Résumé bucket configuration (RM-6) ──────────────────────────────────────────
resource "aws_s3_bucket_versioning" "resumes" {
  bucket = local.resumes_bucket_name
  versioning_configuration {
    status = "Enabled"
  }
}

# Live also carries BlockedEncryptionTypes = [SSE-C], which hashicorp/aws 5.100.0
# cannot express. An import with no diff sends no PutBucketEncryption, so it is
# untouched; any FUTURE change to this resource must re-check it is preserved.
resource "aws_s3_bucket_server_side_encryption_configuration" "resumes" {
  bucket = local.resumes_bucket_name
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = local.resumes_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "resumes" {
  bucket                  = local.resumes_bucket_name
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "resumes" {
  bucket = local.resumes_bucket_name
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# The live rule, not the unapplied module's rules (RM-6).
resource "aws_s3_bucket_lifecycle_configuration" "resumes" {
  bucket                                 = local.resumes_bucket_name
  transition_default_minimum_object_size = "all_storage_classes_128K"

  rule {
    id     = "resume-cleanup-scaffold"
    status = "Enabled"

    # Live: an empty Filter (whole bucket). hashicorp/aws 5.100.0 reads that back as
    # no filter block, so declaring `filter {}` would plan a no-op rewrite of the
    # live lifecycle rule. Omitted to keep the import diff-free.

    expiration {
      expired_object_delete_marker = true
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "resumes" {
  bucket = local.resumes_bucket_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLSRequests"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.resumes_bucket_arn, "${local.resumes_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      # RM-3 (approved change): as in SX-2 item 2, minus the Sign-only actions.
      {
        Sid       = "DenyVersionDeletionAndConfigChangesExceptBreakGlass"
        Effect    = "Deny"
        Principal = "*"
        Action = [
          "s3:DeleteObjectVersion",
          "s3:PutBucketVersioning",
          "s3:PutLifecycleConfiguration",
          "s3:PutBucketObjectLockConfiguration",
        ]
        Resource  = [local.resumes_bucket_arn, "${local.resumes_bucket_arn}/*"]
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.break_glass_principal_arn } }
      },
    ]
  })
}

# ── aramo-api-prod managed policy (RM-6) ────────────────────────────────────────
# Live default version v3, unchanged. It grants nothing on the Sign bucket.
resource "aws_iam_policy" "api_prod" {
  provider = aws.untagged

  name = "aramo-api-prod-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CognitoTenantUserAdmin"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
        ]
        Resource = "arn:aws:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/us-east-1_4fKlnGfaW"
      },
      {
        Sid      = "ResumeBucketObjectRW"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:PutObjectTagging"]
        Resource = "${local.resumes_bucket_arn}/*"
      },
      {
        Sid      = "ResumeKmsUse"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.resumes_kms_key_arn
      },
      {
        Sid      = "TenantAssetsBucketWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "arn:aws:s3:::aramo-prod-tenant-assets-use1/*"
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}
