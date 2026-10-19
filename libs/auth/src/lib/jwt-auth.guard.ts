import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { Request } from 'express';
import {
  importSPKI,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type KeyObject,
} from 'jose';

type VerifyKey = CryptoKey | KeyObject;

import {
  ACTOR_KINDS,
  CONSUMER_TYPES,
  PLATFORM_TENANT_SENTINEL_ID,
  type ActorKind,
  type AuthContext,
  type ConsumerType,
} from './auth-context.types.js';
import {
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  type EffectiveAuthorizationResolver,
} from './effective-authorization-resolver.port.js';
import { CONSUMER_HEADER, selectAccessCookie } from './session-cookie-names.js';

const ISSUER = 'Aramo Core Auth';
const ALG = 'RS256';

// PR-8.0b directive §3 Topic 3 + §8.5: dual-auth widening. The single
// JwtAuthGuard accepts a Bearer header (precedence) or, when absent, the
// `aramo_access_token` cookie. The cookie name is inlined below at its
// single use site (per locked invariant 6 — no shared constant, no
// barrel export); drift versus the auth cookie setter
// (libs/auth-core/src/lib/auth.controller.ts) is caught by the
// Path-B filesystem-read test (§9 case 9, HC.16).

interface AramoJwtPayload extends JWTPayload {
  consumer_type?: string;
  actor_kind?: string;
  tenant_id?: string;
  // HF-AUTH-1 — the compact token carries an authorization REVISION, not a scope
  // list. Effective scopes are resolved server-side by the EffectiveAuthorization
  // resolver and compared against this version for immediate revocation.
  authz_version?: number;
  site_id?: string;
}

// PR-2 precedent #16: real JWS verification. PR-2 verifies tokens only —
// issuance, refresh, key rotation, login, logout are out of scope. The
// public key is read from AUTH_PUBLIC_KEY (PEM SPKI). The audience comes
// from AUTH_AUDIENCE.
//
// Required claims per API Contracts Phase 1 §1: sub, consumer_type,
// tenant_id, scopes, iat, exp. Issuer fixed to "Aramo Core Auth"; expiry
// validated by jose's clock skew window (default 0s).
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private cachedKey: VerifyKey | undefined;
  private cachedKeyPem: string | undefined;

  // HF-AUTH-1 — the app-layer authorization resolver, bound at the composition
  // root to an identity-backed, versioned-cache, fail-closed implementation.
  // Injected as a port so libs/auth takes no dependency on libs/identity.
  //
  // @Optional() because AuthModule PROVIDES this guard as a singleton — every
  // module graph that imports AuthModule (many) would otherwise require the
  // resolver token at construction, breaking sub-graph boots that never bind it.
  // Absence is handled FAIL-CLOSED at request time (see canActivate): a request
  // with no bound resolver is DENIED, never allowed. The real app root always
  // binds it (@Global), so production is unaffected.
  constructor(
    @Optional()
    @Inject(EFFECTIVE_AUTHORIZATION_RESOLVER)
    private readonly resolver?: EffectiveAuthorizationResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & {
          authContext?: AuthContext;
          requestId?: string;
          cookies?: Record<string, string>;
        }
      >();
    const requestId = request.requestId ?? 'unknown';

    const token = this.extractToken(request, requestId);
    const { context: ctx } = await this.verifyAccessToken(token, requestId);
    // D-ORG-4 — a consumer named by the front end must be the consumer the token
    // was minted for: a recruiter cookie presented under `X-Aramo-Consumer: org`
    // (or vice versa) is refused, so no consumer session can stand in for another.
    const declared = request.header(CONSUMER_HEADER);
    if (declared !== undefined && declared !== ctx.consumer_type) {
      throw new AramoError('INVALID_TOKEN', 'Session consumer does not match the declared consumer', 401, {
        requestId,
        details: { reason: 'consumer_header_mismatch', declared, actual: ctx.consumer_type },
      });
    }
    assertTierTripwire(ctx, request.path ?? request.url ?? '', requestId);
    request.authContext = ctx;
    return true;
  }

  // Sign Unified Product S-4 — verify a raw Aramo access token exactly as a
  // protected route does (signature, issuer, audience, required claims, and the
  // server-side effective-scope resolution with immediate revocation), WITHOUT a
  // request. Used for OAuth token exchange, where a first-party application
  // presents its user's access token as the subject of a delegation: the identity
  // and authority are proven by Aramo identity infrastructure, never asserted.
  async verifyAccessToken(token: string, requestId: string): Promise<{ context: AuthContext; authz_version: number }> {
    const audience = process.env['AUTH_AUDIENCE'];
    const publicKeyPem = process.env['AUTH_PUBLIC_KEY'];
    if (audience === undefined || publicKeyPem === undefined) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Auth verification not configured',
        401,
        { requestId, details: { reason: 'missing_env' } },
      );
    }

    let key: VerifyKey;
    try {
      key = await this.resolveKey(publicKeyPem);
    } catch {
      throw new AramoError('INVALID_TOKEN', 'Auth public key invalid', 401, {
        requestId,
      });
    }

    let payload: AramoJwtPayload;
    try {
      const result = await jwtVerify<AramoJwtPayload>(token, key, {
        issuer: ISSUER,
        audience,
        algorithms: [ALG],
      });
      payload = result.payload;
    } catch (err) {
      this.logger.debug(`jwt verification failed: ${(err as Error).message}`);
      throw new AramoError('INVALID_TOKEN', 'Token verification failed', 401, {
        requestId,
      });
    }

    const context = await this.toAuthContext(payload, requestId);
    return { context, authz_version: payload.authz_version as number };
  }

  // Sign Unified Product S-4 — the same principal's effective scopes for ANOTHER
  // consumer (e.g. its `esign` Sign permissions while it holds a recruiter token),
  // resolved server-side at the token's own authorization revision. Fail closed.
  async resolveScopesForConsumer(ctx: AuthContext, consumer: ConsumerType, authzVersion: number, requestId: string): Promise<string[]> {
    if (this.resolver === undefined) {
      throw new AramoError('INVALID_TOKEN', 'Authorization resolver not configured', 401, {
        requestId,
        details: { reason: 'authz_resolver_unbound' },
      });
    }
    const resolution = await this.resolver.resolve({
      tenant_id: ctx.tenant_id,
      principal_id: ctx.sub,
      consumer_type: consumer,
      actor_kind: ctx.actor_kind,
      token_authz_version: authzVersion,
      ...(ctx.site_id !== undefined ? { site_id: ctx.site_id } : {}),
    });
    if (resolution.status !== 'ok') {
      throw new AramoError('INVALID_TOKEN', 'Authorization could not be resolved', 401, {
        requestId,
        details: { reason: resolution.status === 'stale' ? 'authz_version_stale' : 'authz_unresolvable' },
      });
    }
    return resolution.scopes;
  }

  private extractToken(
    request: Request & { cookies?: Record<string, string> },
    requestId: string,
  ): string {
    // Bearer-first / cookie-fallback per PR-8.0b directive §3 Topic 1 + §7.
    // Malformed Authorization header → AUTH_REQUIRED, no cookie fallback.
    // Empty cookie → treated as absent.
    const header = request.header('authorization');
    if (header !== undefined && header.length > 0) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match === null) {
        throw new AramoError(
          'AUTH_REQUIRED',
          'Authorization header must use Bearer scheme',
          401,
          { requestId },
        );
      }
      const token = match[1];
      if (token === undefined || token.length === 0) {
        throw new AramoError(
          'AUTH_REQUIRED',
          'Authorization token empty',
          401,
          { requestId },
        );
      }
      return token;
    }
    // D-ORG-4 — consumer-isolated cookies: the front end names its consumer in
    // `X-Aramo-Consumer`, which selects `aramo_access_token_<consumer>` (legacy
    // `aramo_access_token` as a transition fallback). Without the header the legacy
    // cookie or the SINGLE present consumer cookie is used; two or more consumer
    // cookies without a header is ambiguous and refused (fail closed). The selected
    // token's `consumer_type` claim is verified against the header in canActivate.
    const selection = selectAccessCookie(request.cookies, request.header(CONSUMER_HEADER));
    if (selection.kind === 'invalid_header') {
      throw new AramoError('AUTH_REQUIRED', 'Unknown consumer header', 401, {
        requestId,
        details: { reason: 'invalid_consumer_header' },
      });
    }
    if (selection.kind === 'ambiguous') {
      throw new AramoError('AUTH_REQUIRED', 'Ambiguous session cookies — name the consumer', 401, {
        requestId,
        details: { reason: 'ambiguous_consumer_cookie', present: selection.present },
      });
    }
    if (selection.kind === 'absent') {
      throw new AramoError(
        'AUTH_REQUIRED',
        'Authorization required',
        401,
        { requestId },
      );
    }
    return selection.token;
  }

  private async resolveKey(pem: string): Promise<VerifyKey> {
    if (this.cachedKey !== undefined && this.cachedKeyPem === pem) {
      return this.cachedKey;
    }
    const key = (await importSPKI(pem, ALG)) as VerifyKey;
    this.cachedKey = key;
    this.cachedKeyPem = pem;
    return key;
  }

  // HF-AUTH-1 — validate the COMPACT claim set (no `scopes` claim), then hydrate
  // AuthContext.scopes by resolving them server-side through the authorization
  // resolver. The resolver compares the token's `authz_version` to the current
  // authoritative version: a mismatch is `stale` (immediate revocation → 401), an
  // unprovable authorization is `unresolvable` (fail closed → deny). Downstream
  // @RequireScopes / RolesGuard consumers read AuthContext.scopes unchanged.
  private async toAuthContext(
    payload: AramoJwtPayload,
    requestId: string,
  ): Promise<AuthContext> {
    const { sub, consumer_type, actor_kind, tenant_id, authz_version, iat, exp, site_id } =
      payload;
    if (
      sub === undefined ||
      consumer_type === undefined ||
      actor_kind === undefined ||
      tenant_id === undefined ||
      authz_version === undefined ||
      iat === undefined ||
      exp === undefined
    ) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Required JWT claim missing',
        401,
        { requestId },
      );
    }
    if (!isConsumerType(consumer_type)) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Unknown consumer_type claim',
        401,
        { requestId },
      );
    }
    if (!isActorKind(actor_kind)) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Unknown actor_kind claim',
        401,
        { requestId },
      );
    }
    if (typeof authz_version !== 'number' || !Number.isInteger(authz_version)) {
      throw new AramoError('INVALID_TOKEN', 'Invalid authz_version claim', 401, {
        requestId,
      });
    }

    if (this.resolver === undefined) {
      // No authorization resolver bound in this graph — fail closed. In production
      // the app root always binds it (@Global); reaching here means a protected
      // route ran without the resolver, which must DENY, never allow.
      throw new AramoError(
        'INVALID_TOKEN',
        'Authorization resolver not configured',
        401,
        { requestId, details: { reason: 'authz_resolver_unbound' } },
      );
    }
    const resolution = await this.resolver.resolve({
      tenant_id,
      principal_id: sub,
      consumer_type,
      actor_kind,
      token_authz_version: authz_version,
      ...(site_id !== undefined ? { site_id } : {}),
    });

    if (resolution.status === 'stale') {
      // The principal's authorization changed since this token was minted — force
      // re-authentication/refresh. This is the immediate-revocation lever.
      throw new AramoError(
        'INVALID_TOKEN',
        'Authorization revision is stale; re-authenticate',
        401,
        { requestId, details: { reason: 'authz_version_stale' } },
      );
    }
    if (resolution.status === 'unresolvable') {
      // Authorization could not be PROVEN (canonical store unreachable and no
      // trustworthy cache). Fail closed — never trust the token's own claims.
      throw new AramoError(
        'INVALID_TOKEN',
        'Authorization could not be resolved',
        401,
        { requestId, details: { reason: 'authz_unresolvable' } },
      );
    }

    return {
      sub,
      consumer_type,
      actor_kind,
      tenant_id,
      scopes: resolution.scopes,
      iat,
      exp,
      ...(site_id !== undefined ? { site_id } : {}),
    };
  }
}

// Addendum S6 — the raw access token of an authenticated request (the same
// Bearer-first / consumer-cookie selection JwtAuthGuard verifies), for a
// server-side delegation such as Aramo Sign USER-mode token exchange. Returns
// null instead of throwing; never log the value.
export function rawAccessToken(request: Request & { cookies?: Record<string, string> }): string | null {
  const header = request.header('authorization');
  if (header !== undefined && header.length > 0) {
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m !== null && m[1] !== undefined && m[1].length > 0 ? m[1] : null;
  }
  const selection = selectAccessCookie(request.cookies, request.header(CONSUMER_HEADER));
  return selection.kind === 'found' ? selection.token : null;
}

// IC-2 PR-5 — the GENERIC both-direction tier tripwire (AUTHZ-2 DDR §13.1;
// IC-0 §F.2 rule 2 / J-10). Replaces reliance on per-route hand-placed
// assertions (which stay as defence in depth):
//   (a) a `platform` token is accepted ONLY on a platform route (`/platform/…`)
//       — a platform operator can never act through a tenant-facing route;
//   (b) a non-platform token is NEVER accepted on a platform route — a tenant
//       session cannot acquire platform-operator authority;
//   (c) the platform SENTINEL tenant id is legitimate only for the `platform`
//       consumer (operators) and the `portal` consumer (portal sessions carry the
//       sentinel by design) — any other consumer presenting it is refused.
// Existing error contract: 403 INSUFFICIENT_PERMISSIONS (the code every
// hand-placed tripwire already emits), reason in details, no tenant named.
export function isPlatformRoutePath(path: string): boolean {
  return path === '/platform' || path.startsWith('/platform/');
}

export function assertTierTripwire(
  ctx: Pick<AuthContext, 'consumer_type' | 'tenant_id'>,
  path: string,
  requestId: string,
): void {
  const platformRoute = isPlatformRoutePath(path);
  let reason: string | null = null;
  if (ctx.consumer_type === 'platform' && !platformRoute) {
    reason = 'platform_token_on_tenant_route';
  } else if (ctx.consumer_type !== 'platform' && platformRoute) {
    reason = 'tenant_token_on_platform_route';
  } else if (
    ctx.tenant_id === PLATFORM_TENANT_SENTINEL_ID &&
    ctx.consumer_type !== 'platform' &&
    ctx.consumer_type !== 'portal'
  ) {
    reason = 'sentinel_tenant_requires_platform_consumer';
  }
  if (reason !== null) {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Tier boundary violation', 403, {
      requestId,
      details: { reason },
    });
  }
}

function isConsumerType(value: string): value is ConsumerType {
  return (CONSUMER_TYPES as readonly string[]).includes(value);
}

function isActorKind(value: string): value is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(value);
}
