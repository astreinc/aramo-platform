import { createPrivateKey, createPublicKey } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { exportJWK } from 'jose';

import { computeKid } from './jwt-issuer.service.js';

// Per directive §3 JWKS sub-block + §8.6. Single-key JWKS derived from
// AUTH_PRIVATE_KEY; rotation deferred. `kid` is the SHA-256 fingerprint
// of the SPKI-encoded public key (matches JwtIssuerService.computeKid so
// signed JWTs and the published JWKS agree on `kid`).
//
// Cache-Control: public, max-age=300 (set by the controller).

export interface JwksKey {
  kty: 'RSA';
  use: 'sig';
  alg: 'RS256';
  kid: string;
  n: string;
  e: string;
}

export interface JwksDocument {
  keys: JwksKey[];
}

@Injectable()
export class JwksService {
  private cached: JwksDocument | undefined;
  private cachedFromPem: string | undefined;

  async getJwks(): Promise<JwksDocument> {
    const pem = process.env['AUTH_PRIVATE_KEY'];
    if (pem === undefined || pem.length === 0) {
      throw new Error('AUTH_PRIVATE_KEY is not configured');
    }
    if (this.cached !== undefined && this.cachedFromPem === pem) {
      return this.cached;
    }
    const privKey = createPrivateKey({ key: pem, format: 'pem' });
    const pubKey = createPublicKey(privKey);
    const jwk = await exportJWK(pubKey);
    if (jwk.n === undefined || jwk.e === undefined) {
      throw new Error('jwks_export_missing_rsa_components');
    }
    const kid = computeKid(pubKey);
    const doc: JwksDocument = {
      keys: [
        { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e },
      ],
    };
    this.cached = doc;
    this.cachedFromPem = pem;
    return doc;
  }
}
