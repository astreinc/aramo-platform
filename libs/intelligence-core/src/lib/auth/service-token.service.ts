import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { ServiceTokenResponse } from '@aramo/intelligence-contracts';
import { SignJWT, jwtVerify } from 'jose';

import {
  INTELLIGENCE_UNIT_OF_WORK,
  type IntelligenceUnitOfWork,
  type ServiceClient,
} from '../repositories/types.js';

// ATI-SEP-1 T2 (ADR-0036 §3 "Service auth (E-2)") — client-credentials token
// exchange. A ServiceClient presents client_id + client_secret (scrypt-hashed at
// rest) and receives a short-lived HS256 JWT signed with
// INTELLIGENCE_SERVICE_TOKEN_SECRET. The guard re-loads the client on every call:
// a deactivated client stops working immediately, not at token expiry.

export const INTELLIGENCE_SERVICE_TOKEN_SECRET_ENV = 'INTELLIGENCE_SERVICE_TOKEN_SECRET';
export const SERVICE_TOKEN_ISSUER = 'aramo-talent-intelligence';
export const SERVICE_TOKEN_AUDIENCE = 'aramo-talent-intelligence';
export const SERVICE_TOKEN_TTL_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;

export type ServiceTokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'unsupported_grant_type'
  | 'invalid_token'
  | 'server_misconfigured';

export class ServiceTokenError extends Error {
  constructor(
    readonly code: ServiceTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceTokenError';
  }
}

export interface ServicePrincipal {
  client_id: string;
  source_system_id: string;
  scopes: string[];
}

const SCRYPT_KEYLEN = 32;

/** scrypt$<salt b64url>$<hash b64url> — store this, never the secret. */
export function hashClientSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyClientSecret(secret: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(secret, Buffer.from(saltB64, 'base64url'), expected.length || SCRYPT_KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A constant dummy hash so an unknown client_id costs the same scrypt as a known one.
const DUMMY_HASH = hashClientSecret(randomUUID());

@Injectable()
export class ServiceTokenService {
  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  private key(env: NodeJS.ProcessEnv = process.env): Uint8Array {
    const secret = env[INTELLIGENCE_SERVICE_TOKEN_SECRET_ENV]?.trim() ?? '';
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new ServiceTokenError(
        'server_misconfigured',
        `${INTELLIGENCE_SERVICE_TOKEN_SECRET_ENV} is not configured (>= ${MIN_SECRET_LENGTH} characters)`,
      );
    }
    return new TextEncoder().encode(secret);
  }

  private loadClient(clientId: string): Promise<ServiceClient | null> {
    return this.uow.run((repos) => repos.clients.find(clientId));
  }

  /** grant_type=client_credentials → a short-lived bearer token. */
  async exchange(input: {
    grant_type?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
    scope?: unknown;
  }): Promise<ServiceTokenResponse> {
    const key = this.key();
    if (input.grant_type !== 'client_credentials') {
      throw new ServiceTokenError('unsupported_grant_type', 'only grant_type=client_credentials is supported');
    }
    if (typeof input.client_id !== 'string' || typeof input.client_secret !== 'string' || input.client_id.length === 0) {
      throw new ServiceTokenError('invalid_request', 'client_id and client_secret are required');
    }
    const client = await this.loadClient(input.client_id);
    const secretOk = verifyClientSecret(input.client_secret, client?.secret_hash ?? DUMMY_HASH);
    if (client === null || !secretOk || !client.active) {
      throw new ServiceTokenError('invalid_client', 'client authentication failed');
    }
    const allowed = client.allowed_scopes ?? [];
    let scopes = allowed;
    if (input.scope !== undefined) {
      if (typeof input.scope !== 'string') throw new ServiceTokenError('invalid_request', 'scope must be a string');
      scopes = input.scope.split(' ').filter((s) => s.length > 0);
      if (scopes.length === 0 || scopes.some((s) => !allowed.includes(s))) {
        throw new ServiceTokenError('invalid_scope', 'requested scope exceeds the client grant');
      }
    }
    const scope = [...new Set(scopes)].join(' ');
    const access_token = await new SignJWT({ scope, source_system_id: client.source_system_id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SERVICE_TOKEN_ISSUER)
      .setAudience(SERVICE_TOKEN_AUDIENCE)
      .setSubject(client.client_id)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SERVICE_TOKEN_TTL_SECONDS}s`)
      .sign(key);
    return { access_token, token_type: 'Bearer', expires_in: SERVICE_TOKEN_TTL_SECONDS, scope };
  }

  /** Verify a bearer token AND that its client is still active with the same source system. */
  async verify(token: string): Promise<ServicePrincipal> {
    const key = this.key();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: SERVICE_TOKEN_ISSUER,
        audience: SERVICE_TOKEN_AUDIENCE,
      }));
    } catch {
      throw new ServiceTokenError('invalid_token', 'the bearer token is invalid or expired');
    }
    const clientId = payload['sub'];
    const sourceSystem = payload['source_system_id'];
    const scope = payload['scope'];
    if (typeof clientId !== 'string' || typeof sourceSystem !== 'string' || typeof scope !== 'string') {
      throw new ServiceTokenError('invalid_token', 'the bearer token is missing claims');
    }
    const client = await this.loadClient(clientId);
    if (client === null || !client.active || client.source_system_id !== sourceSystem) {
      throw new ServiceTokenError('invalid_token', 'the service client is no longer authorized');
    }
    const granted = scope.split(' ').filter((s) => s.length > 0 && (client.allowed_scopes ?? []).includes(s));
    return { client_id: clientId, source_system_id: sourceSystem, scopes: granted };
  }
}
