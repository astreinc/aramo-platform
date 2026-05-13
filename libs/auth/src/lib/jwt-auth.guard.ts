import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
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
  type ActorKind,
  type AuthContext,
  type ConsumerType,
} from './auth-context.types.js';

const ISSUER = 'Aramo Core Auth';
const ALG = 'RS256';

// PR-8.0b directive §3 Topic 3 + §8.5: dual-auth widening. The single
// JwtAuthGuard accepts a Bearer header (precedence) or, when absent, the
// `aramo_access_token` cookie. The cookie name is inlined below at its
// single use site (per locked invariant 6 — no shared constant, no
// barrel export); drift versus the auth-service cookie setter
// (apps/auth-service/src/app/auth/auth.controller.ts) is caught by the
// Path-B filesystem-read test (§9 case 9, HC.16).

interface AramoJwtPayload extends JWTPayload {
  consumer_type?: string;
  actor_kind?: string;
  tenant_id?: string;
  scopes?: string[];
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

    const ctx = this.toAuthContext(payload, requestId);
    request.authContext = ctx;
    return true;
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
    const cookieValue = request.cookies?.['aramo_access_token'];
    if (cookieValue === undefined || cookieValue.length === 0) {
      throw new AramoError(
        'AUTH_REQUIRED',
        'Authorization required',
        401,
        { requestId },
      );
    }
    return cookieValue;
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

  private toAuthContext(
    payload: AramoJwtPayload,
    requestId: string,
  ): AuthContext {
    const { sub, consumer_type, actor_kind, tenant_id, scopes, iat, exp } =
      payload;
    if (
      sub === undefined ||
      consumer_type === undefined ||
      actor_kind === undefined ||
      tenant_id === undefined ||
      scopes === undefined ||
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
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
      throw new AramoError('INVALID_TOKEN', 'Invalid scopes claim', 401, {
        requestId,
      });
    }
    return {
      sub,
      consumer_type,
      actor_kind,
      tenant_id,
      scopes,
      iat,
      exp,
    };
  }
}

function isConsumerType(value: string): value is ConsumerType {
  return (CONSUMER_TYPES as readonly string[]).includes(value);
}

function isActorKind(value: string): value is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(value);
}
