import { Injectable } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';

import { loadObjectStorageConfig, type ObjectStorageConfig } from './object-storage.config.js';

// A8-3a — S3Client factory.
//
// Lazy-init pattern (matches the M5 SecretCacheService at
// libs/ai-draft/src/lib/secrets/secret-cache.service.ts:31): a single
// instance-level S3Client cached for the lifetime of the Nest
// singleton.
//
// Credentials: SDK default chain (env / shared / instance-profile /
// IRSA) — never hardcoded. Setting S3_ENDPOINT switches to path-style
// for LocalStack-backed integration tests; in prod S3_ENDPOINT is
// unset and the SDK uses the default AWS endpoint.

@Injectable()
export class S3ClientFactory {
  private cached: S3Client | null = null;
  private cachedConfig: ObjectStorageConfig | null = null;

  getClient(): S3Client {
    if (this.cached !== null) return this.cached;
    const config = this.getConfig();
    this.cached = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      // AWS SDK JS v3 (≥3.729) defaults requestChecksumCalculation to
      // 'WHEN_SUPPORTED', which injects x-amz-sdk-checksum-algorithm /
      // x-amz-checksum-crc32 into PutObject and folds them into the presigned
      // URL's SignedHeaders. Our presigned URLs are consumed by PLAIN HTTP
      // clients (the ats-web browser PUT in talent-api.ts putResumeToStorage,
      // and server-side fetch() GETs in resume-parse / talent-record) that do
      // NOT send those headers → SignatureDoesNotMatch → uploads/downloads
      // fail. Pin both to 'WHEN_REQUIRED' (the pre-3.729 behaviour) so presigned
      // URLs stay usable by non-SDK clients. Caught by the A8-3a/A8-3b LocalStack
      // integration proofs once libs/object-storage + libs/resume-parse were
      // enrolled in CI (PR-B).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.endpoint !== null ? { endpoint: config.endpoint } : {}),
    });
    return this.cached;
  }

  getConfig(): ObjectStorageConfig {
    if (this.cachedConfig === null) {
      this.cachedConfig = loadObjectStorageConfig();
    }
    return this.cachedConfig;
  }
}
