import { SignJWT, decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  SERVICE_TOKEN_AUDIENCE,
  SERVICE_TOKEN_ISSUER,
  ServiceTokenService,
  hashClientSecret,
  verifyClientSecret,
} from '../index.js';

import { InMemoryIntelligence } from './support/in-memory-intelligence.js';

// ATI-SEP-1 T2 — client-credentials exchange + bearer verification.

const ENV = 'INTELLIGENCE_SERVICE_TOKEN_SECRET';
const SECRET = 's'.repeat(40);

describe('ServiceTokenService', () => {
  let saved: string | undefined;
  let mem: InMemoryIntelligence;
  let svc: ServiceTokenService;

  beforeAll(() => {
    saved = process.env[ENV];
    process.env[ENV] = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  beforeEach(async () => {
    mem = new InMemoryIntelligence();
    svc = new ServiceTokenService(mem);
    await mem.run((r) =>
      r.clients.upsert({
        client_id: 'ats',
        secret_hash: hashClientSecret('ats-secret'),
        allowed_scopes: ['intelligence:ingest'],
        source_system_id: 'ARAMO_ATS',
        active: true,
      }),
    );
  });

  it('secret hashes are salted scrypt and verify only the right secret', () => {
    const h = hashClientSecret('x');
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toBe(hashClientSecret('x'));
    expect(verifyClientSecret('x', h)).toBe(true);
    expect(verifyClientSecret('y', h)).toBe(false);
    expect(verifyClientSecret('x', 'plain')).toBe(false);
  });

  it('issues a 300s HS256 token carrying sub / scope / source_system_id, which verifies', async () => {
    const t = await svc.exchange({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret' });
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 300, scope: 'intelligence:ingest' });
    const claims = decodeJwt(t.access_token);
    expect(claims).toMatchObject({ sub: 'ats', scope: 'intelligence:ingest', source_system_id: 'ARAMO_ATS', iss: SERVICE_TOKEN_ISSUER });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
    await expect(svc.verify(t.access_token)).resolves.toEqual({ client_id: 'ats', source_system_id: 'ARAMO_ATS', scopes: ['intelligence:ingest'] });
  });

  it.each([
    [{ grant_type: 'password', client_id: 'ats', client_secret: 'ats-secret' }, 'unsupported_grant_type'],
    [{ grant_type: 'client_credentials', client_id: 'ats' }, 'invalid_request'],
    [{ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'wrong' }, 'invalid_client'],
    [{ grant_type: 'client_credentials', client_id: 'nobody', client_secret: 'x' }, 'invalid_client'],
    [{ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret', scope: 'intelligence:admin' }, 'invalid_scope'],
  ])('refuses %j with %s', async (input, code) => {
    await expect(svc.exchange(input)).rejects.toMatchObject({ code });
  });

  it('an inactive client can neither exchange nor use an already-issued token', async () => {
    const t = await svc.exchange({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret' });
    await mem.run(async (r) => {
      const c = await r.clients.find('ats');
      await r.clients.upsert({ ...c!, allowed_scopes: c!.allowed_scopes, active: false });
    });
    await expect(svc.verify(t.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(svc.exchange({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret' })).rejects.toMatchObject({
      code: 'invalid_client',
    });
  });

  it('rejects tokens with a wrong key, wrong audience, alg none, or expired', async () => {
    const key = new TextEncoder().encode(SECRET);
    const base = () =>
      new SignJWT({ scope: 'intelligence:ingest', source_system_id: 'ARAMO_ATS' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('ats')
        .setIssuer(SERVICE_TOKEN_ISSUER)
        .setIssuedAt();
    const wrongKey = await base().setAudience(SERVICE_TOKEN_AUDIENCE).setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(40)));
    const wrongAud = await base().setAudience('other').setExpirationTime('5m').sign(key);
    const expired = await base().setAudience(SERVICE_TOKEN_AUDIENCE).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key);
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'ats', aud: SERVICE_TOKEN_AUDIENCE, iss: SERVICE_TOKEN_ISSUER })).toString('base64url');
    for (const t of [wrongKey, wrongAud, expired, `${header}.${body}.`, 'garbage']) {
      await expect(svc.verify(t)).rejects.toMatchObject({ code: 'invalid_token' });
    }
  });

  it('fails closed without INTELLIGENCE_SERVICE_TOKEN_SECRET', async () => {
    process.env[ENV] = 'short';
    try {
      await expect(svc.exchange({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret' })).rejects.toMatchObject({
        code: 'server_misconfigured',
      });
    } finally {
      process.env[ENV] = SECRET;
    }
  });
});
