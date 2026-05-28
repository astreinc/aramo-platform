import { Injectable, Optional } from '@nestjs/common';

// M5 PR-11 §4.1 — extracted from libs/matching/src/lib/redis/redis-connection.config.ts
// to libs/common for cross-lib reuse. ADR-0018 Decision 2 codifies the
// cross-lib reuse pattern (consent stale-consent + outbox-publisher;
// common cross-schema-consistency; skills-taxonomy skill-canonicalization
// all consume the same shared config).
//
// M3 PR-3 §4.2 — Redis connection config service.
//
// Lead Gate-5 fix ruling (Option B, lazy validation): the constructor
// performs NO env read, NO validation, NO throw. It only stores the
// @Optional() redisUrl argument for later resolution. Validation +
// parsing happens on first access of the `connection` getter and is
// memoized thereafter.
//
// The MatchingModule / ConsentModule / CommonModule / SkillsTaxonomyModule
// BullModule.forRootAsync factories invoke this getter at factory-invocation
// time. Each factory tolerates the "not configured" throw so module init
// can complete; the actual failure surfaces only when a queue push/pop
// attempts a Redis command.
//
// PR-11 added the `isConfigured` accessor so processor onApplicationBootstrap
// hooks can short-circuit Worker construction without provoking the throw
// when REDIS_URL is absent (mirrors libs/matching's pre-PR-11 inline env
// check at matching.processor.ts onApplicationBootstrap).
@Injectable()
export class RedisConnectionConfig {
  private readonly explicitUrl?: string;
  private cached: RedisConnectionOptions | undefined;

  constructor(@Optional() redisUrl?: string) {
    this.explicitUrl = redisUrl;
  }

  // PR-11 §4.1 — non-throwing check for whether REDIS_URL is configured.
  // Used by job-processor onApplicationBootstrap hooks to gate
  // BullRegistrar.register() without provoking the lazy `connection`
  // getter's throw.
  get isConfigured(): boolean {
    const url = this.explicitUrl ?? process.env['REDIS_URL'];
    return url !== undefined && url.length > 0;
  }

  // Lazy accessor. Resolves (constructor-supplied URL ?? process.env),
  // throws "REDIS_URL is not configured" if unset/empty, parses to
  // ConnectionOptions, and memoizes the result for subsequent calls.
  get connection(): RedisConnectionOptions {
    if (this.cached !== undefined) {
      return this.cached;
    }
    const url = this.explicitUrl ?? process.env['REDIS_URL'];
    if (url === undefined || url.length === 0) {
      throw new Error('REDIS_URL is not configured');
    }
    this.cached = parseRedisUrl(url);
    return this.cached;
  }
}

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
}

function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  const port = parsed.port.length > 0 ? Number(parsed.port) : 6379;
  const options: RedisConnectionOptions = {
    host: parsed.hostname,
    port,
  };
  if (parsed.username.length > 0) {
    options.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password.length > 0) {
    options.password = decodeURIComponent(parsed.password);
  }
  const pathDb = parsed.pathname.replace(/^\//, '');
  if (pathDb.length > 0) {
    const db = Number(pathDb);
    if (Number.isInteger(db) && db >= 0) {
      options.db = db;
    }
  }
  return options;
}
