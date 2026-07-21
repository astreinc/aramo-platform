import { AramoError } from '@aramo/common';

// A8-3a — Object-storage env-var binding + the PII-floor expiry caps.
//
// The presigned-URL expiry cap is a PII floor: a presigned URL is a
// bearer credential, so short expiry bounds the leak blast-radius if
// the URL escapes the intended client. The directive §2 names ≤ 5 min;
// we cap at 300 seconds in code (the service rejects any caller-
// supplied expiry > MAX).
//
// Env-vars (the substrate consumes these at module-init time):
//   S3_RESUME_BUCKET  — bucket name (provisioned by the terraform
//                       module infrastructure/modules/s3-resume-bucket).
//                       Format: aramo-<env>-resumes.
//                       SRC-1 PR-2 (R13.2): this ONE platform document bucket now
//                       holds tenant talent-document PII broadly — résumés (the
//                       '/talent/…' key prefix) AND server-originated ingestion
//                       payloads (the '/ingestion/{channel}/…' prefix, e.g. Indeed
//                       Apply). The env var's résumé-specific NAME is retained
//                       (ADD-not-rename: renaming a live env var is deploy-path
//                       risk for zero benefit). A dedicated ingestion bucket is a
//                       forcing-function decision (counsel-mandated divergent
//                       retention/encryption posture), not a tidiness one.
//   AWS_REGION        — region (matches the M5 secret-cache pattern).
//                       Default 'us-east-1' (ADR-0012 Decision 1).
//   S3_ENDPOINT       — optional. LocalStack endpoint URL for integration
//                       tests; unset in prod (SDK uses default AWS).
//
// Credentials follow the AWS SDK default chain (env / shared
// credentials / instance-profile / IRSA) — never hardcoded. Matches
// the M5 secret-cache pattern (libs/ai-draft/src/lib/secrets/
// secret-cache.service.ts).

export const OBJECT_STORAGE_MAX_EXPIRY_SECONDS = 300;
export const OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS = 300;

// A8-3b — orphan-sweep tag constants.
//
// The S3 lifecycle Rule 5 (infrastructure/modules/s3-resume-bucket/main.tf)
// filters on tag `lifecycle = orphan-pending` and expires matching objects
// after var.orphan_retention_days (default 1d). The presigned PUT URL
// bakes this tag into the signed payload; AttachmentService calls
// markResumeCommitted on successful is_resume=true attach, which replaces
// the tag with `lifecycle = committed` so the sweep skips it.
//
// Keeping the tag key + values as constants prevents drift between the
// terraform rule, the presigner, and the tag-clear call.
export const ORPHAN_SWEEP_TAG_KEY = 'lifecycle' as const;
export const ORPHAN_SWEEP_TAG_VALUE_PENDING = 'orphan-pending' as const;
export const ORPHAN_SWEEP_TAG_VALUE_COMMITTED = 'committed' as const;

export interface ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | null;
  readonly forcePathStyle: boolean;
}

export function loadObjectStorageConfig(): ObjectStorageConfig {
  const bucket = process.env['S3_RESUME_BUCKET'];
  if (bucket === undefined || bucket.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      'S3_RESUME_BUCKET env-var is not set',
      500,
      {
        requestId: 'object-storage-config',
        details: { kind: 'env_missing', name: 'S3_RESUME_BUCKET' },
      },
    );
  }

  const region = process.env['AWS_REGION'] ?? 'us-east-1';

  // Optional LocalStack endpoint for integration tests. Setting the
  // endpoint implies path-style URLs (LocalStack does not host
  // virtual-host-style buckets at arbitrary hostnames).
  const endpoint = process.env['S3_ENDPOINT'] ?? null;
  const forcePathStyle = endpoint !== null;

  return { bucket, region, endpoint, forcePathStyle };
}

export function assertExpiryWithinCap(expiresInSeconds: number): void {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'expires_in_seconds must be a positive integer',
      400,
      {
        requestId: 'object-storage-config',
        details: { field: 'expires_in_seconds', value: expiresInSeconds },
      },
    );
  }
  if (expiresInSeconds > OBJECT_STORAGE_MAX_EXPIRY_SECONDS) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `expires_in_seconds exceeds the PII-floor cap of ${OBJECT_STORAGE_MAX_EXPIRY_SECONDS}s`,
      400,
      {
        requestId: 'object-storage-config',
        details: {
          field: 'expires_in_seconds',
          value: expiresInSeconds,
          cap: OBJECT_STORAGE_MAX_EXPIRY_SECONDS,
        },
      },
    );
  }
}
