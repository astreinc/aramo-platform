import { Global, Module, type DynamicModule } from '@nestjs/common';
import { RedisConnectionConfig } from '@aramo/common';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { IdentityCoreModule } from '../identity-core.module.js';

import {
  AUTHZ_RESOLVER_CONFIG,
  type AuthzResolverConfig,
  IdentityEffectiveAuthorizationResolver,
} from './identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from './in-memory-scope-cache.js';
import { RedisScopeCache } from './redis-scope-cache.js';
import { AUTHORIZATION_SCOPE_CACHE } from './scope-cache.port.js';

// HF-AUTH-1 — the app-composition-root binding of the authorization resolver.
//
// @Global so the api JwtAuthGuard (used across every module) and the auth-service
// /session controller can inject EFFECTIVE_AUTHORIZATION_RESOLVER without each
// feature module re-importing this. Bound once per app via forRoot(config); the
// app passes PORTAL_SESSION_SCOPES (from @aramo/auth-core) so libs/identity takes
// no auth-core dependency.
//
// Cache selection: a Redis-backed shared snapshot when REDIS_URL is configured
// (multi-instance), else the per-process in-memory cache (single-box / dev / test).
// Either way the resolver logic — version match, canonical-RBAC fallback, fail
// closed — is identical.
@Global()
@Module({})
export class AuthorizationResolverModule {
  static forRoot(config: AuthzResolverConfig): DynamicModule {
    return {
      module: AuthorizationResolverModule,
      imports: [IdentityCoreModule],
      providers: [
        { provide: AUTHZ_RESOLVER_CONFIG, useValue: config },
        {
          provide: AUTHORIZATION_SCOPE_CACHE,
          useFactory: () => {
            const url = process.env['REDIS_URL'];
            return url !== undefined && url.length > 0
              ? new RedisScopeCache(new RedisConnectionConfig(url))
              : new InMemoryScopeCache();
          },
        },
        {
          provide: EFFECTIVE_AUTHORIZATION_RESOLVER,
          useClass: IdentityEffectiveAuthorizationResolver,
        },
      ],
      exports: [EFFECTIVE_AUTHORIZATION_RESOLVER, AUTHORIZATION_SCOPE_CACHE, AUTHZ_RESOLVER_CONFIG],
    };
  }
}
