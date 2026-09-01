import { Injectable } from '@nestjs/common';
import {
  importSPKI,
  jwtVerify,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { ALG, ISSUER } from './jwt-issuer.service.js';

// Auth-service-local cookie-based JWT verifier. Mirrors the verification
// mechanism in libs/auth's JwtAuthGuard (RS256 + AUTH_PUBLIC_KEY + 0s
// clock tolerance) but reads from a cookie payload (string) instead of
// the Authorization header. Per directive §4 + §8.5.

export interface CookieJwtPayload {
  // AUTHZ-2: 'platform' is the 4th consumer_type (Lead ruling 3 — extend
  // auth-service; reuse the PKCE/JWKS pipeline). Matches CONSUMER_TYPES
  // in libs/auth/auth-context.types.ts.
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion' | 'platform';
  tenant_id: string;
  // HF-AUTH-1 — the compact cookie carries an authorization REVISION, NOT a scope
  // list. /session resolves the effective scopes server-side for its response body.
  authz_version: number;
  site_id?: string;
  iat: number;
  exp: number;
}

const CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion', 'platform'] as const;

@Injectable()
export class CookieVerifierService {
  private cachedKey: CryptoKey | KeyObject | undefined;
  private cachedKeyPem: string | undefined;

  async verify(jwt: string): Promise<CookieJwtPayload> {
    const audience = process.env['AUTH_AUDIENCE'];
    if (audience === undefined || audience.length === 0) {
      throw new Error('AUTH_AUDIENCE is not configured');
    }
    const key = await this.resolveKey();
    const result = await jwtVerify<Record<string, unknown>>(jwt, key, {
      issuer: ISSUER,
      audience,
      algorithms: [ALG],
    });
    const p = result.payload;
    const consumer_type = p['consumer_type'];
    const tenant_id = p['tenant_id'];
    const authz_version = p['authz_version'];
    const site_id = p['site_id'];
    if (
      typeof p['sub'] !== 'string' ||
      typeof consumer_type !== 'string' ||
      typeof tenant_id !== 'string' ||
      typeof authz_version !== 'number' ||
      !Number.isInteger(authz_version) ||
      typeof p['iat'] !== 'number' ||
      typeof p['exp'] !== 'number'
    ) {
      throw new Error('jwt_required_claim_missing');
    }
    if (!(CONSUMER_TYPES as readonly string[]).includes(consumer_type)) {
      throw new Error('jwt_invalid_consumer_type');
    }
    return {
      sub: p['sub'],
      consumer_type: consumer_type as CookieJwtPayload['consumer_type'],
      tenant_id,
      authz_version,
      ...(typeof site_id === 'string' ? { site_id } : {}),
      iat: p['iat'],
      exp: p['exp'],
    };
  }

  private async resolveKey(): Promise<CryptoKey | KeyObject> {
    const pem = process.env['AUTH_PUBLIC_KEY'];
    if (pem === undefined || pem.length === 0) {
      throw new Error('AUTH_PUBLIC_KEY is not configured');
    }
    if (this.cachedKey !== undefined && this.cachedKeyPem === pem) {
      return this.cachedKey;
    }
    const key = (await importSPKI(pem, ALG)) as CryptoKey | KeyObject;
    this.cachedKey = key;
    this.cachedKeyPem = pem;
    return key;
  }
}
