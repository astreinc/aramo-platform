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
