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
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

const CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion'] as const;

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
    const scopes = p['scopes'];
    if (
      typeof p['sub'] !== 'string' ||
      typeof consumer_type !== 'string' ||
      typeof tenant_id !== 'string' ||
      typeof p['iat'] !== 'number' ||
      typeof p['exp'] !== 'number'
    ) {
      throw new Error('jwt_required_claim_missing');
    }
    if (!(CONSUMER_TYPES as readonly string[]).includes(consumer_type)) {
      throw new Error('jwt_invalid_consumer_type');
    }
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
      throw new Error('jwt_invalid_scopes');
    }
    return {
      sub: p['sub'],
      consumer_type: consumer_type as CookieJwtPayload['consumer_type'],
      tenant_id,
      scopes: scopes as string[],
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
