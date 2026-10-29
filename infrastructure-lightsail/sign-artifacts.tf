# Aramo Sign: Executed-Artifact Custody and Isolation Directive v1.0 (LOCKED),
# SX-2 items 1, 2, 3, 5 (infrastructure part) and 6, under Lead Clarifications
# LC-1 (retention) and LC-3 (evidence signing).
#
# AUTHORED, NOT APPLIED. Terraform apply, the IAM change and the credential switch
# are separate PO-authorized production checkpoints (directive, "Production
# restrictions"). Apply runs from the Mac only (recon gate R-1).
#
# What this file creates:
#   - aramo-prod-sign-artifacts-use1: the dedicated Sign artifact bucket. Object Lock
#     enabled at creation (IRREVERSIBLE), versioned, SSE-KMS with its own key
#     (rotation on), all four public-access-block flags, BucketOwnerEnforced, a
#     TLS-only policy, an explicit Deny on version deletion, governance bypass and
#     configuration changes for every principal except the break-glass principal,
#     and NO lifecycle rules at all (no expiry of current or older versions).
#   - the key policy for the EXISTING DOC-4 evidence-signing key (doc4-sign.tf,
#     aws_kms_key.sign_evidence, RSA_2048, alias/aramo-sign-evidence), which is
#     reused for LC-3 / SX-1 item 4. No second evidence key is created.
#   - the IAM user aramo-sign-prod (sign-service only) and its inline policy. NO
#     access key here: a key created by Terraform would put the secret into state.
#     The key is created at the credential-switch checkpoint, out-of-band.
#   - a CloudTrail trail (this region) with management events plus S3 WRITE data
#     events for the Sign bucket, delivered to its own log bucket.
#
# aramo-api-prod gets NO access to the Sign bucket or either key: its policy is not
# touched, and neither key policy delegates to IAM (no account-root statement).

locals {
  sign_bucket_arn = "arn:aws:s3:::${var.sign_artifacts_bucket_name}"
  sign_s3_via     = "s3.${var.aws_region}.amazonaws.com"

  # Key layout (SX-2 item 4): every artifact lives under tenants/<tenant_id>/.
  sign_objects_arn = "${local.sign_bucket_arn}/tenants/*"
  # Draft delete keeps working on source objects only (SX-2 items 5 and 6).
  sign_source_objects_arn = "${local.sign_bucket_arn}/tenants/*/envelopes/*/source/*"

  # Forms of "this key" a client may name in x-amz-server-side-encryption-aws-kms-key-id.
  sign_artifacts_kms_key_id_forms = [
    aws_kms_key.sign_artifacts.arn,
    aws_kms_key.sign_artifacts.key_id,
    aws_kms_alias.sign_artifacts.arn,
    aws_kms_alias.sign_artifacts.name,
  ]

  sign_audit_bucket_arn = "arn:aws:s3:::${var.sign_audit_log_bucket_name}"
  sign_audit_trail_arn  = "arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${var.sign_audit_trail_name}"

  # KMS administration only: no data-key, decrypt or signing use.
  kms_admin_actions = [
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
}

# ── The sign-service principal (SX-2 item 6) ─────────────────────────────────────
# User + inline policy ONLY. The access key is created at the credential-switch
# checkpoint (`aws iam create-access-key --user-name aramo-sign-prod`) and staged
# into the sign-service env only (recon gate R-2). It never enters Terraform state.
resource "aws_iam_user" "sign" {
  name = var.sign_iam_user_name

  tags = {
    Role = "sign-service"
  }
}

data "aws_iam_policy_document" "sign_user" {
  statement {
    sid    = "SignArtifactObjectReadWriteAndRetention"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObjectRetention",
      "s3:GetObjectRetention",
    ]
    resources = [local.sign_objects_arn]
  }

  # Draft delete: source objects only. On a versioned bucket this writes a delete
  # marker; the version itself can be removed only by the break-glass principal.
  statement {
    sid       = "SignSourceObjectDelete"
    effect    = "Allow"
    actions   = ["s3:DeleteObject"]
    resources = [local.sign_source_objects_arn]
  }

  # Reconcile (SX-2 item 7) lists the tenant prefix to find missing uploads.
  statement {
    sid       = "SignArtifactListTenantPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [local.sign_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tenants/*"]
    }
  }

  statement {
    sid       = "SignArtifactKmsDataKeyUse"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.sign_artifacts.arn]
  }

  # kms:Verify: KmsEvidenceManifestSigner.verify() calls VerifyCommand
  # (apps/sign-service/src/app/kms-evidence-manifest-signer.ts).
  statement {
    sid    = "SignEvidenceKeyUse"
    effect = "Allow"
    actions = [
      "kms:Sign",
      "kms:Verify",
      "kms:GetPublicKey",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.sign_evidence.arn]
  }

  # Belt and braces next to the bucket policy: this principal can never remove a
  # version or bypass Governance retention, whatever else is ever attached to it.
  statement {
    sid    = "SignNeverDeletesVersionsOrBypassesRetention"
    effect = "Deny"
    actions = [
      "s3:DeleteObjectVersion",
      "s3:BypassGovernanceRetention",
    ]
    resources = [local.sign_bucket_arn, "${local.sign_bucket_arn}/*"]
  }
}

resource "aws_iam_user_policy" "sign" {
  name   = "${var.sign_iam_user_name}-artifacts"
  user   = aws_iam_user.sign.name
  policy = data.aws_iam_policy_document.sign_user.json
}

# ── Artifact bucket key: dedicated symmetric key, rotation on ─────────────────────
data "aws_iam_policy_document" "sign_artifacts_kms" {
  statement {
    sid    = "BreakGlassAdministersTheKey"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [var.break_glass_principal_arn]
    }
    actions   = local.kms_admin_actions
    resources = ["*"]
  }

  # Recovery: the break-glass principal can read artifacts back through S3.
  statement {
    sid    = "BreakGlassDecryptsThroughS3"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [var.break_glass_principal_arn]
    }
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.sign_s3_via]
    }
  }

  statement {
    sid    = "SignServiceUsesTheKeyThroughS3"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.sign.arn]
    }
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.sign_s3_via]
    }
  }
}

resource "aws_kms_key" "sign_artifacts" {
  description             = "Aramo Sign executed-artifact bucket SSE-KMS (SX-2)"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.sign_artifacts_kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "sign_artifacts" {
  name          = var.sign_artifacts_kms_alias
  target_key_id = aws_kms_key.sign_artifacts.key_id
}

# ── Evidence-manifest signing key policy (LC-3) ──────────────────────────────────
# Attached to the existing DOC-4 key in doc4-sign.tf (RSA_2048, SIGN_VERIFY; the
# sign-service signer uses RSASSA_PSS_SHA_256). Admin = break-glass principal;
# only aramo-sign-prod may sign. No account-root statement, so IAM cannot delegate
# use of the key to any other principal (aramo-api-prod included).
data "aws_iam_policy_document" "sign_evidence_kms" {
  statement {
    sid    = "BreakGlassAdministersTheKey"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [var.break_glass_principal_arn]
    }
    actions   = local.kms_admin_actions
    resources = ["*"]
  }

  # Custody checks: the break-glass principal can verify signatures, never sign.
  statement {
    sid    = "BreakGlassVerifiesEvidence"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [var.break_glass_principal_arn]
    }
    actions   = ["kms:Verify", "kms:GetPublicKey"]
    resources = ["*"]
  }

  statement {
    sid    = "SignServiceSignsEvidence"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.sign.arn]
    }
    actions = [
      "kms:Sign",
      "kms:Verify",
      "kms:GetPublicKey",
      "kms:DescribeKey",
    ]
    resources = ["*"]
  }
}

# ── The Sign artifact bucket (SX-2 items 1, 2, 5) ────────────────────────────────
# Enabling Object Lock is IRREVERSIBLE: record it at the apply checkpoint.
resource "aws_s3_bucket" "sign_artifacts" {
  bucket              = var.sign_artifacts_bucket_name
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "sign_artifacts" {
  bucket = aws_s3_bucket.sign_artifacts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "sign_artifacts" {
  bucket                  = aws_s3_bucket.sign_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "sign_artifacts" {
  bucket = aws_s3_bucket.sign_artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sign_artifacts" {
  bucket = aws_s3_bucket.sign_artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.sign_artifacts.arn
    }
    bucket_key_enabled = true
  }
}

# LC-1: NO default retention unless a Legal/PO-approved period is set. With
# sign_artifacts_default_retention_days = null (the default) no Object Lock
# configuration rule exists and retention is not applied. Per SX-2 item 5 the
# executed, certificate and evidence objects get PER-OBJECT Governance retention
# from sign-service; a bucket default would ALSO cover source objects, which the
# directive says carry none. Leave this null unless a later ruling says otherwise.
resource "aws_s3_bucket_object_lock_configuration" "sign_artifacts" {
  count  = var.sign_artifacts_default_retention_days == null ? 0 : 1
  bucket = aws_s3_bucket.sign_artifacts.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.sign_artifacts_default_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.sign_artifacts]
}

data "aws_iam_policy_document" "sign_artifacts_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [local.sign_bucket_arn, "${local.sign_bucket_arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # SX-2 item 2: nobody but the named break-glass principal may remove a version,
  # bypass Governance retention, or change versioning, Object Lock, lifecycle or
  # this policy. Note: this includes the Terraform operator unless the operator IS
  # the break-glass principal.
  statement {
    sid    = "DenyCustodyChangesExceptBreakGlass"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = [
      "s3:DeleteObjectVersion",
      "s3:BypassGovernanceRetention",
      "s3:PutBucketVersioning",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketPolicy",
    ]
    resources = [local.sign_bucket_arn, "${local.sign_bucket_arn}/*"]
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [var.break_glass_principal_arn]
    }
  }

  # An upload that names an encryption explicitly must name SSE-KMS with THIS key.
  # Uploads that name none fall through to the bucket default (this key). Each
  # check applies only when the header is present (Null = false).
  statement {
    sid    = "DenyPutWithNonKmsSse"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.sign_bucket_arn}/*"]
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
    sid    = "DenyPutWithOtherKmsKey"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.sign_bucket_arn}/*"]
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = local.sign_artifacts_kms_key_id_forms
    }
  }
}

resource "aws_s3_bucket_policy" "sign_artifacts" {
  bucket = aws_s3_bucket.sign_artifacts.id
  policy = data.aws_iam_policy_document.sign_artifacts_bucket.json

  # The public access block must exist first or a policy update can race it.
  depends_on = [aws_s3_bucket_public_access_block.sign_artifacts]
}

# ── Audit trail (SX-2 item 3) ───────────────────────────────────────────────────
# Cost floor: one trail in this region, no CloudWatch Logs, no Insights. The
# account has no other trail, so the management-event copy is the free one; S3
# data events are WRITE-only and scoped to the Sign bucket.
resource "aws_s3_bucket" "sign_audit_logs" {
  bucket = var.sign_audit_log_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "sign_audit_logs" {
  bucket = aws_s3_bucket.sign_audit_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "sign_audit_logs" {
  bucket                  = aws_s3_bucket.sign_audit_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "sign_audit_logs" {
  bucket = aws_s3_bucket.sign_audit_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sign_audit_logs" {
  bucket = aws_s3_bucket.sign_audit_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "sign_audit_logs_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [local.sign_audit_bucket_arn, "${local.sign_audit_bucket_arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AWSCloudTrailAclCheck"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    actions   = ["s3:GetBucketAcl"]
    resources = [local.sign_audit_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.sign_audit_trail_arn]
    }
  }

  statement {
    sid    = "AWSCloudTrailWrite"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.sign_audit_bucket_arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.sign_audit_trail_arn]
    }
  }

  # The audit record of the Sign bucket is itself kept: only the break-glass
  # principal may delete log objects or versions.
  statement {
    sid    = "DenyLogDeletionExceptBreakGlass"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${local.sign_audit_bucket_arn}/*"]
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [var.break_glass_principal_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "sign_audit_logs" {
  bucket = aws_s3_bucket.sign_audit_logs.id
  policy = data.aws_iam_policy_document.sign_audit_logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.sign_audit_logs]
}

resource "aws_cloudtrail" "sign_audit" {
  name                          = var.sign_audit_trail_name
  s3_bucket_name                = aws_s3_bucket.sign_audit_logs.id
  is_multi_region_trail         = false
  include_global_service_events = true
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "Management events"
    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  advanced_event_selector {
    name = "Sign artifact bucket object writes"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field  = "readOnly"
      equals = ["false"]
    }
    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.sign_artifacts.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.sign_audit_logs]
}
