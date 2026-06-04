import { Inject, Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AramoError, type AramoLogger } from '@aramo/common';

import {
  OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS,
  ORPHAN_SWEEP_TAG_KEY,
  ORPHAN_SWEEP_TAG_VALUE_COMMITTED,
  ORPHAN_SWEEP_TAG_VALUE_PENDING,
  assertExpiryWithinCap,
} from './object-storage.config.js';
import { buildResumeObjectKey, parseResumeObjectKey } from './key-convention.js';
import { hashIdentifierForLog } from './log-redaction.js';
import { S3ClientFactory } from './s3-client.factory.js';
import type {
  CreatePresignedGetInput,
  CreateResumePresignedPutInput,
  MarkResumeCommittedInput,
  PresignedGetResult,
  PresignedPutResult,
} from './types/presigned-url.types.js';

// A8-3a — ObjectStorageService: the presigned PUT/GET surface.
//
// The API never hosts bytes — the recruiter's browser PUTs directly to
// S3 against the signed URL this service returns (the A4 design
// comment, now realised). Likewise downloads: the browser GETs against
// a signed URL.
//
// PII floor (directive §2):
//   - presigned URLs are short-lived bearer credentials → expiry hard-
//     capped at OBJECT_STORAGE_MAX_EXPIRY_SECONDS (300) per
//     assertExpiryWithinCap; defaults to OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS
//   - every PUT/GET helper invocation emits a structured access-log
//     entry (the audit-trail floor; the full F16 mechanics — encrypted-
//     index, elevated-permission access, multi-party audit — remain
//     deferred per the talent-evidence precedent).

@Injectable()
export class ObjectStorageService {
  constructor(
    private readonly s3Factory: S3ClientFactory,
    @Inject('ObjectStorageServiceLogger') private readonly logger: AramoLogger,
  ) {}

  async createResumePresignedPut(
    input: CreateResumePresignedPutInput,
  ): Promise<PresignedPutResult> {
    const expiresInSeconds =
      input.expires_in_seconds ?? OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS;
    assertExpiryWithinCap(expiresInSeconds);

    const storage_key = buildResumeObjectKey({
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      filename: input.filename,
      requestId: input.requestId,
    });

    const { bucket } = this.s3Factory.getConfig();
    const client = this.s3Factory.getClient();

    // A8-3b — bake the orphan-sweep tag into the signed payload. The
    // browser sends `x-amz-tagging` as part of the PUT; S3 applies the
    // tag at object-create time. The S3 lifecycle Rule 5 (the
    // terraform module) expires objects tagged orphan-pending after
    // var.orphan_retention_days (default 1d). On successful is_resume=true
    // attach, markResumeCommitted clears the tag so the object is not
    // swept. Without this tag, an abandoned upload would leak indefinitely.
    const orphanTagging = `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`;

    let presigned_url: string;
    try {
      presigned_url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: storage_key,
          ContentType: input.content_type,
          Tagging: orphanTagging,
        }),
        { expiresIn: expiresInSeconds },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AramoError(
        'OBJECT_STORAGE_UPLOAD_FAILED',
        `presigned PUT generation failed: ${message}`,
        502,
        {
          requestId: input.requestId,
          details: { kind: 'presign_put_failed', bucket, storage_key },
        },
      );
    }

    const expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // PII-floor access-log: every PUT helper call is observable. The
    // raw talent_record_id is HASHED here (the Gate-5 review-item-3
    // pre-commit change); the real id stays in the S3 key path only.
    this.logger.log({
      event: 'object_storage.presigned_put_issued',
      requestId: input.requestId,
      bucket,
      storage_key,
      tenant_id: input.tenant_id,
      talent_record_id_hash: hashIdentifierForLog(input.talent_record_id),
      content_type: input.content_type,
      expires_in_seconds: expiresInSeconds,
      expires_at,
    });

    return { storage_key, presigned_url, expires_at };
  }

  async createPresignedGet(
    input: CreatePresignedGetInput,
  ): Promise<PresignedGetResult> {
    const expiresInSeconds =
      input.expires_in_seconds ?? OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS;
    assertExpiryWithinCap(expiresInSeconds);

    if (input.storage_key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'storage_key must be non-empty',
        400,
        { requestId: input.requestId, details: { field: 'storage_key' } },
      );
    }

    const { bucket } = this.s3Factory.getConfig();
    const client = this.s3Factory.getClient();

    let presigned_url: string;
    try {
      presigned_url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: input.storage_key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AramoError(
        'OBJECT_STORAGE_UPLOAD_FAILED',
        `presigned GET generation failed: ${message}`,
        502,
        {
          requestId: input.requestId,
          details: { kind: 'presign_get_failed', bucket, storage_key: input.storage_key },
        },
      );
    }

    const expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // PII-floor access-log. If the storage_key parses as an A8-3a
    // tenant-scoped key, include the HASHED talent_record_id for
    // group-by-talent correlation (the Gate-5 review-item-3
    // pre-commit change). Non-A8-3a-shape keys (legacy / ingestion
    // refs) emit without the field.
    const parsed = parseResumeObjectKey(input.storage_key);
    this.logger.log({
      event: 'object_storage.presigned_get_issued',
      requestId: input.requestId,
      bucket,
      storage_key: input.storage_key,
      ...(parsed !== null
        ? { talent_record_id_hash: hashIdentifierForLog(parsed.talent_record_id) }
        : {}),
      expires_in_seconds: expiresInSeconds,
      expires_at,
    });

    return { presigned_url, expires_at };
  }

  /**
   * A8-3b — clear the orphan-pending tag on a résumé object after the
   * Attachment row is committed. AttachmentService calls this from its
   * create path when is_resume=true, the post-DB-commit step.
   *
   * Failure semantics: this method THROWS on S3 failure. The caller
   * (AttachmentService) is expected to log + alert on failure but NOT
   * roll back the Attachment row -- the worst case is that the
   * committed object is swept in 24h, recoverable via S3 versioning
   * (object versions persist for var.noncurrent_version_retention_days,
   * default 90d). The Attachment row remains a valid pointer; a future
   * reconciliation job (HK) can re-tag if needed.
   */
  async markResumeCommitted(input: MarkResumeCommittedInput): Promise<void> {
    if (input.storage_key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'storage_key must be non-empty',
        400,
        { requestId: input.requestId, details: { field: 'storage_key' } },
      );
    }

    const { bucket } = this.s3Factory.getConfig();
    const client = this.s3Factory.getClient();

    try {
      await client.send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: input.storage_key,
          Tagging: {
            TagSet: [
              {
                Key: ORPHAN_SWEEP_TAG_KEY,
                Value: ORPHAN_SWEEP_TAG_VALUE_COMMITTED,
              },
            ],
          },
        }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AramoError(
        'OBJECT_STORAGE_UPLOAD_FAILED',
        `object tag-clear failed: ${message}`,
        502,
        {
          requestId: input.requestId,
          details: {
            kind: 'mark_committed_failed',
            bucket,
            storage_key: input.storage_key,
          },
        },
      );
    }

    const parsed = parseResumeObjectKey(input.storage_key);
    this.logger.log({
      event: 'object_storage.resume_marked_committed',
      requestId: input.requestId,
      bucket,
      storage_key: input.storage_key,
      ...(parsed !== null
        ? { talent_record_id_hash: hashIdentifierForLog(parsed.talent_record_id) }
        : {}),
    });
  }
}
