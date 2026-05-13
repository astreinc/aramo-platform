import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { SignJWT, importPKCS8, type CryptoKey } from 'jose';

// Per directive §3 Topic 2 (JWT contract). Byte-exact issuer literal —
// kept in lockstep with libs/auth's ISSUER constant by an issuer-drift
// test (see jwt-issuer.service.spec.ts test 22).
//
// `actor_kind` is emitted in the JWT payload but NOT surfaced via libs/
// auth's AuthContext (which keeps its 6-field shape per Q5 deferral).
//
// Access token TTL = 900 seconds (15 minutes) per Topic 2 + intake lock.

export const ISSUER = 'Aramo Core Auth';
export const ALG = 'RS256';
export const ACCESS_TOKEN_TTL_SECONDS = 900;

export interface JwtIssuancePayload {
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
  scopes: string[];
}

@Injectable()
export class JwtIssuerService {
  private cachedSigningKey: CryptoKey | KeyObject | undefined;
  private cachedKeyPem: string | undefined;
  private cachedKid: string | undefined;

  async sign(payload: JwtIssuancePayload): Promise<string> {
    const audience = process.env['AUTH_AUDIENCE'];
    if (audience === undefined || audience.length === 0) {
      throw new Error('AUTH_AUDIENCE is not configured');
    }
    const { signingKey, kid } = await this.resolveKey();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: payload.sub,
      actor_kind: 'user',
      consumer_type: payload.consumer_type,
      tenant_id: payload.tenant_id,
      scopes: payload.scopes,
    })
      .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(payload.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
      .sign(signingKey);
  }

  private async resolveKey(): Promise<{ signingKey: CryptoKey | KeyObject; kid: string }> {
    const pem = process.env['AUTH_PRIVATE_KEY'];
    if (pem === undefined || pem.length === 0) {
      throw new Error('AUTH_PRIVATE_KEY is not configured');
    }
    if (this.cachedSigningKey !== undefined && this.cachedKeyPem === pem && this.cachedKid !== undefined) {
      return { signingKey: this.cachedSigningKey, kid: this.cachedKid };
    }
    const signingKey = (await importPKCS8(pem, ALG)) as CryptoKey | KeyObject;
    // Derive kid from the corresponding public key's SPKI DER fingerprint
    // so /.well-known/jwks.json publishes the same kid the issuer signs with.
    const privKeyObj = createPrivateKey({ key: pem, format: 'pem' });
    const pubKeyObj = createPublicKey(privKeyObj);
    const kid = computeKid(pubKeyObj);
    this.cachedSigningKey = signingKey;
    this.cachedKeyPem = pem;
    this.cachedKid = kid;
    return { signingKey, kid };
  }
}

export function computeKid(pubKey: KeyObject): string {
  const spkiDer = pubKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spkiDer).digest('base64url');
}
