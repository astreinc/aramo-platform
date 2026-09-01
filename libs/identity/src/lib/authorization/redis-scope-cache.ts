import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisConnectionConfig } from '@aramo/common';
import { Redis } from 'ioredis';

import type { AuthorizationScopeCache } from './scope-cache.port.js';

// HF-AUTH-1 — Redis-backed implementation of the versioned scope-snapshot cache.
//
// Bound at the app composition root when REDIS_URL is configured (multi-instance
// deployments need a SHARED snapshot; the single-process InMemoryScopeCache is the
// dev/test/no-Redis default). Values are the resolved effective scope set for one
// principal at one authorization version, stored as JSON with a bounded TTL under
// the immutable `authz:{tenant}:{principal}:{version}:{site}` key the resolver
// builds. A version bump simply uses a new key, so no invalidation is needed.
//
// Failure model (the RESOLVER enforces fail-closed): a genuine MISS returns null;
// an UNREACHABLE backend THROWS. The resolver treats a throw as "cache down →
// resolve from canonical RBAC without caching" (still proves authorization) and
// only fails closed when the canonical store is ALSO unreachable. The cache never
// expands privilege.
@Injectable()
export class RedisScopeCache implements AuthorizationScopeCache {
  private readonly logger = new Logger(RedisScopeCache.name);
  private client: Redis | undefined;

  constructor(@Optional() private readonly redisConfig?: RedisConnectionConfig) {}

  async get(key: string): Promise<string[] | null> {
    const raw = await this.conn().get(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        return parsed as string[];
      }
    } catch {
      // Corrupt entry — treat as a miss (the resolver re-resolves from canonical).
      this.logger.warn(`discarding corrupt scope-cache entry for ${key}`);
    }
    return null;
  }

  async set(key: string, scopes: string[], ttlSeconds: number): Promise<void> {
    await this.conn().set(key, JSON.stringify(scopes), 'EX', ttlSeconds);
  }

  // One lazily-constructed shared client. `lazyConnect` defers the TCP connect to
  // first command; `maxRetriesPerRequest: 0` makes a command fail FAST (reject)
  // when Redis is unreachable rather than queueing — so the resolver's catch fires
  // promptly and falls through to canonical RBAC instead of hanging the request.
  private conn(): Redis {
    if (this.client !== undefined) return this.client;
    const options = this.redisConfig?.connection ?? { host: '127.0.0.1', port: 6379 };
    this.client = new Redis({
      ...options,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    this.client.on('error', (err) => {
      // Connection-level errors are expected to surface as command rejections the
      // resolver handles; log at debug to avoid noise.
      this.logger.debug(`redis scope-cache error: ${err.message}`);
    });
    return this.client;
  }
}
