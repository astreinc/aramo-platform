import { Injectable, Optional } from '@nestjs/common';

// M3 PR-3 §4.2 — Redis connection config service.
//
// Mirrors PR-16's libs/consent PrismaService @Optional() pattern verbatim:
// the constructor parameter is @Optional() so Nest DI can resolve the
// undecorated primitive without throwing on String-token resolution
// (PR-16 F11 root cause). The env fallback runs inside the constructor
// body; the throw fires only when REDIS_URL is unset/empty, so apps/api
// boots without a live Redis as long as a non-empty REDIS_URL is set.
//
// Surface: derives an ioredis ConnectionOptions object from a REDIS_URL.
// BullModule.forRootAsync (libs/matching/src/lib/matching.module.ts) injects
// this service to build its connection. No connection is opened here —
// ioredis connects lazily when the first queue/worker operation runs.
@Injectable()
export class RedisConnectionConfig {
  readonly connection: RedisConnectionOptions;

  constructor(@Optional() redisUrl?: string) {
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (url === undefined || url.length === 0) {
      throw new Error('REDIS_URL is not configured');
    }
    this.connection = parseRedisUrl(url);
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
