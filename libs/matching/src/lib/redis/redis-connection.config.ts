import { Injectable, Optional } from '@nestjs/common';

// M3 PR-3 §4.2 — Redis connection config service.
//
// Lead Gate-5 fix ruling (Option B, lazy validation): the constructor
// performs NO env read, NO validation, NO throw. It only stores the
// @Optional() redisUrl argument for later resolution. Validation +
// parsing happens on first access of the `connection` getter and is
// memoized thereafter.
//
// Why: PR-16's @Optional() pattern makes the constructor PARAMETER
// resolvable by Nest DI (the F11 root-cause fix), but it does NOT defer
// the constructor body — eager validation still throws at instantiation
// time. The §8.1-B pass D4 finding anticipated exactly this: pact:provider
// boots apps/api under DI with no REDIS_URL stub, so an eager throw in
// the constructor breaks boot. The directive §4.2 intent — "apps/api
// boots without a live Redis" — is only truly met when REDIS_URL is
// validated lazily, at first use, not at construction.
//
// The MatchingModule BullModule.forRootAsync factory is responsible for
// invoking this getter at factory-invocation time. The factory tolerates
// the "not configured" throw so module init can complete; the actual
// failure surfaces only when a queue push/pop attempts a Redis command.
@Injectable()
export class RedisConnectionConfig {
  private readonly explicitUrl?: string;
  private cached: RedisConnectionOptions | undefined;

  constructor(@Optional() redisUrl?: string) {
    this.explicitUrl = redisUrl;
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
