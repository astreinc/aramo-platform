# s3-resume-bucket

Aramo Terraform module — provisions the **résumé-class S3 bucket** with the
PII floor mandated by the A8-3a directive §2.

Fourth module populated under `infrastructure/modules/` (after
`cloudwatch-log-group`, `vpc`, `rds`). Follows the same shape as the
M5 PR-10a `rds` module: dedicated encryption key + sensitive outputs +
Postgres-RDS-style validation on inputs.

## Purpose

A8-3a activates the dormant `Attachment.storage_key` (libs/attachment,
A4) + `RawPayloadReference.storage_ref` (libs/ingestion, M2) patterns
with a live S3 backend. This module owns the bucket-level posture; the
client + presigned-URL helpers live in `libs/object-storage` (the
`@aramo/object-storage` lib).

## The PII floor (the §2 directive items)

Résumés are dense PII and do not ride the enum-column F16 deferral the
`talent-evidence` repository accepts. This module enforces:

- **Private bucket** — `aws_s3_bucket_public_access_block` with all
  four flags `true`.
- **SSE-KMS** with a **dedicated CMK** (departs from ADR-0016 Decision 7
  account-default posture). `bucket_key_enabled = true` for cost
  optimization.
- **Versioning enabled** — recoverability + accidental-delete defense.
- **CORS scoped to `var.cors_allowed_origins`** — NEVER `"*"` (the
  variable's validation block rejects open CORS).
- **Lifecycle aligned to `TalentDocumentRetentionPolicy`** — 3 rules
  keyed on the `retention_policy` object tag (default / extended /
  delete_after_X_days) + a 4th rule aborting incomplete multipart
  uploads.
- **Server-access logging** to a separate `aramo-<env>-resumes-logs`
  bucket (the bucket-level audit-trail floor; the application emits
  per-PUT/GET access-log entries from `ObjectStorageService`).

**Short-expiry presigned URLs are enforced at the LIB layer** (libs/
object-storage caps `expires_in_seconds` at 300 via
`assertExpiryWithinCap`), NOT as a bucket policy.

## What this module does NOT do

- **The IAM role** that binds the emitted policy to the app principal
  lives in the broader IAM module the readiness track will deliver.
  This module emits the policy DOCUMENT (`app_iam_policy_json`); the
  consumer wires it to a role.
- **The full F16 PII treatment** (elevated-permission gating, encrypted
  application-side index, multi-party audit) — remains a follow-up.
  A8-3a does the FLOOR.
- **Application-layer key generation** — `libs/object-storage`'s
  `buildResumeObjectKey` is the authority on key shape
  (`{tenant_id}/talent/{talent_record_id}/resume/{uuid}-{filename}`).

## Inputs

| Name                                  | Type           | Default | Description |
| ------------------------------------- | -------------- | ------- | ----------- |
| `environment`                         | `string`       | n/a     | One of `dev` \| `staging` \| `prod`. |
| `cors_allowed_origins`                | `list(string)` | n/a     | Origins permitted to PUT/GET directly via presigned URLs. NEVER `"*"`. |
| `kms_deletion_window_in_days`         | `number`       | `30`    | KMS CMK deletion window (7-30). |
| `retention_days_default`              | `number`       | `365`   | `retention_policy = default` expiration (≥ 30). |
| `retention_days_extended`             | `number`       | `2555`  | `retention_policy = extended` expiration (≥ 365). |
| `retention_days_delete_after_x_floor` | `number`       | `90`    | Bucket-level floor for `delete_after_X_days` tagged objects (≥ 7). |
| `noncurrent_version_retention_days`   | `number`       | `90`    | Noncurrent-version expiry (≥ 7). |
| `access_log_retention_days`           | `number`       | `365`   | Server-access-log retention in the logs bucket (≥ 30). |
| `tags`                                | `map(string)`  | `{}`    | Tag overlay (in addition to provider `default_tags`). |

## Outputs

| Name                  | Sensitive | Description |
| --------------------- | --------- | ----------- |
| `bucket_name`         | no        | The résumé-bucket name. Wire to `S3_RESUME_BUCKET` env-var. |
| `bucket_arn`          | no        | The résumé-bucket ARN. |
| `logs_bucket_name`    | no        | The server-access-logs destination bucket. |
| `kms_key_arn`         | **yes**   | The dedicated CMK ARN (kept out of plan/apply logs). |
| `kms_key_alias`       | no        | The friendly alias for the dedicated CMK. |
| `app_iam_policy_json` | no        | Least-privilege IAM policy doc the app needs to PUT/GET. |

## Example composition (per-environment)

```hcl
module "resume_bucket" {
  source = "../../modules/s3-resume-bucket"

  environment           = var.environment
  cors_allowed_origins  = var.resume_bucket_cors_allowed_origins
  retention_days_default  = var.resume_bucket_retention_days_default
  retention_days_extended = var.resume_bucket_retention_days_extended
}
```
