import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { DNS_RESOLVER_PORT, StubDnsAdapter } from '@aramo/identity';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import { MAILER_PORT, type MailerPort, type SendEmailInput } from '@aramo/mailer';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// Domain-Enforcement P3 (LOCKED) §7 items 12–14, through the REAL apps/api module
// graph + real PostgreSQL + the STUB DNS resolver:
//   12  P2b VERIFIED promotes the claim to AUTHORITATIVE; a promotion while another
//       organization holds the domain is refused (tenant stays VERIFIED, claim not
//       authoritative, the other holder untouched).
//   13  Re-issuing the P2b token while VERIFIED is refused (409 already_verified).
//   14  A delegate link shows the record and triggers the check (and the
//       promotion); it reaches no tenant route and creates no membership; unknown,
//       expired and revoked links give 404; the token is accepted only in the body.

const __authzTestResolver = new ConfigurableTestResolver();

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-domain-verification-p3-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-0000000000a1'; // verifies, becomes AUTHORITATIVE
const TENANT_B = '11111111-0000-7000-8000-0000000000b1'; // delegates to its IT admin
const TENANT_C = '11111111-0000-7000-8000-0000000000c1'; // LAPSED claim; D holds the domain
const TENANT_D = '11111111-0000-7000-8000-0000000000d1'; // the other holder of C's domain
const ADMIN_A = '00000000-0000-7000-8000-0000000a0001';
const ADMIN_B = '00000000-0000-7000-8000-0000000b0001';
const ADMIN_C = '00000000-0000-7000-8000-0000000c0001';
const DOMAIN_A = 'alpha-p3.example';
const DOMAIN_B = 'bravo-p3.example';
const DOMAIN_C = 'charlie-p3.example';

interface Res {
  status: number;
  body: Record<string, unknown>;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Domain-Enforcement P3 — domain verification ↔ domain claim + delegation',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let stub: StubDnsAdapter;
    const sent: SendEmailInput[] = [];
    const jwt: Record<string, string> = {};

    function signJwt(key: SignKey, sub: string, tenant_id: string, scopes: string[], consumer_type = 'recruiter'): Promise<string> {
      return new SignJWT({
        sub,
        consumer_type,
        actor_kind: 'user',
        tenant_id,
        authz_version: __authzTestResolver.grant(tenant_id, sub, scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function call(method: string, path: string, opts: { jwt?: string; body?: unknown; consumer?: string } = {}): Promise<Res> {
      const headers: Record<string, string> = {};
      if (opts.consumer !== undefined) headers['X-Aramo-Consumer'] = opts.consumer;
      if (opts.jwt !== undefined) headers['Authorization'] = `Bearer ${opts.jwt}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      return { status: res.status, body };
    }

    async function claimOf(tenantId: string): Promise<{ claim: string; reason: string | null } | null> {
      const r = await db.query(`SELECT claim, reason FROM identity."TenantDomainClaim" WHERE tenant_id = $1::uuid`, [tenantId]);
      return r.rows[0] ?? null;
    }
    async function auditCount(tenantId: string, eventType: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM identity."IdentityAuditEvent" WHERE tenant_id = $1::uuid AND event_type = $2`,
        [tenantId, eventType],
      );
      return r.rows[0].n as number;
    }
    async function publishFor(tenantId: string, domain: string): Promise<void> {
      const r = await db.query(`SELECT domain_verification_token AS t FROM identity."Tenant" WHERE id = $1::uuid`, [tenantId]);
      stub.setRecords(`_aramo-challenge.${domain}`, [`aramo-domain-verification=${r.rows[0].t as string}`]);
    }
    function lastToken(): string {
      const text = sent[sent.length - 1]?.text ?? '';
      const m = /#token=([A-Za-z0-9_%-]+)/.exec(text);
      if (m === null) throw new Error('no delegate link in the last email');
      return decodeURIComponent(m[1] as string);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of [ENTITLEMENT_INIT, ...resolveIdentityMigrations(ROOT)]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      for (const [t, name, domain] of [
        [TENANT_A, 'Alpha P3', DOMAIN_A],
        [TENANT_B, 'Bravo P3', DOMAIN_B],
        [TENANT_C, 'Charlie P3', DOMAIN_C],
        [TENANT_D, 'Delta P3', DOMAIN_C],
      ] as const) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`,
          [t],
        );
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, is_active, allowed_domain, created_at, updated_at)
           VALUES ($1::uuid, $2, true, $3, now(), now())`,
          [t, name, domain],
        );
      }
      // Claims as P3 creation would leave them: A and B PROVISIONAL (unexpired);
      // C LAPSED; D the AUTHORITATIVE holder of C's domain.
      const future = new Date(Date.now() + 20 * 86_400_000);
      for (const [t, d, claim, exp] of [
        [TENANT_A, DOMAIN_A, 'PROVISIONAL', future],
        [TENANT_B, DOMAIN_B, 'PROVISIONAL', future],
        [TENANT_C, DOMAIN_C, 'LAPSED', null],
        [TENANT_D, DOMAIN_C, 'AUTHORITATIVE', null],
      ] as const) {
        await db.query(
          `INSERT INTO identity."TenantDomainClaim" (tenant_id, domain, claim, expires_at, reason) VALUES ($1::uuid, $2, $3, $4, 'seed')`,
          [t, d, claim, exp],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const key = kp.privateKey as SignKey;
      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'ARAMO_SIGN_BASE_URL']) savedEnv[k] = process.env[k];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.p3.test';

      jwt['A'] = await signJwt(key, ADMIN_A, TENANT_A, ['tenant:admin:domain']);
      jwt['B'] = await signJwt(key, ADMIN_B, TENANT_B, ['tenant:admin:domain']);
      jwt['C'] = await signJwt(key, ADMIN_C, TENANT_C, ['tenant:admin:domain']);
      // P3 §4 — the Aramo Sign workspace calls these routes with its `sign`
      // consumer session (sign host → nginx exception → apps/api).
      jwt['B_SIGN'] = await signJwt(key, ADMIN_B, TENANT_B, ['tenant:admin:domain'], 'sign');

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      stub = module.get<StubDnsAdapter>(DNS_RESOLVER_PORT, { strict: false });
      const mailer = module.get<MailerPort>(MAILER_PORT, { strict: false });
      vi.spyOn(mailer, 'send').mockImplementation(async (m: SendEmailInput) => {
        sent.push(m);
        return { message_id: `spy-${sent.length}` };
      });
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // ── 12 ──
    it('12a — P2b VERIFIED promotes the PROVISIONAL claim to AUTHORITATIVE (same-transaction audit)', async () => {
      const issued = await call('POST', '/v1/tenant/domain-verification', { jwt: jwt['A'] });
      expect(issued.status).toBe(200);
      expect(issued.body['domain_claim']).toBe('PROVISIONAL');
      await publishFor(TENANT_A, DOMAIN_A);
      const checked = await call('POST', '/v1/tenant/domain-verification/check', { jwt: jwt['A'] });
      expect(checked.status).toBe(200);
      expect(checked.body['status']).toBe('VERIFIED');
      expect(checked.body['domain_claim']).toBe('AUTHORITATIVE');
      expect(checked.body['domain_claim_conflict']).toBe(false);
      expect(await claimOf(TENANT_A)).toEqual({ claim: 'AUTHORITATIVE', reason: 'domain_verified' });
      expect(await auditCount(TENANT_A, 'identity.domain.claim.authoritative')).toBe(1);
      expect(await auditCount(TENANT_A, 'identity.domain.verified')).toBe(1);
    });

    it('12b — a promotion while another organization holds the domain is refused: VERIFIED stays, the claim is not authoritative', async () => {
      await call('POST', '/v1/tenant/domain-verification', { jwt: jwt['C'] });
      await publishFor(TENANT_C, DOMAIN_C);
      const checked = await call('POST', '/v1/tenant/domain-verification/check', { jwt: jwt['C'] });
      expect(checked.status).toBe(200);
      expect(checked.body['status']).toBe('VERIFIED');
      expect(checked.body['domain_claim']).toBe('LAPSED');
      expect(checked.body['domain_claim_conflict']).toBe(true);
      expect(await claimOf(TENANT_C)).toEqual({ claim: 'LAPSED', reason: 'seed' });
      expect(await claimOf(TENANT_D)).toEqual({ claim: 'AUTHORITATIVE', reason: 'seed' });
      expect(await auditCount(TENANT_C, 'identity.domain.claim.authoritative')).toBe(0);
      // GET reports the same conflict (never which organization holds it).
      const read = await call('GET', '/v1/tenant/domain-verification', { jwt: jwt['C'] });
      expect(read.body['domain_claim_conflict']).toBe(true);
      expect(JSON.stringify(read.body)).not.toContain(TENANT_D);
    });

    it('the Sign workspace session (consumer_type sign + X-Aramo-Consumer: sign) is accepted by the tenant routes', async () => {
      const res = await call('GET', '/v1/tenant/domain-verification', { jwt: jwt['B_SIGN'], consumer: 'sign' });
      expect(res.status).toBe(200);
      expect(res.body['allowed_domain']).toBe(DOMAIN_B);
      const list = await call('GET', '/v1/tenant/domain-verification/delegations', { jwt: jwt['B_SIGN'], consumer: 'sign' });
      expect(list.status).toBe(200);
    });

    // ── 13 ──
    it('13 — re-issuing the token while VERIFIED is refused (409 already_verified) and nothing changes', async () => {
      const before = await db.query(`SELECT domain_verification_token AS t FROM identity."Tenant" WHERE id = $1::uuid`, [TENANT_A]);
      const res = await call('POST', '/v1/tenant/domain-verification', { jwt: jwt['A'] });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('already_verified');
      const after = await db.query(
        `SELECT domain_verification_token AS t, domain_verification_status AS s FROM identity."Tenant" WHERE id = $1::uuid`,
        [TENANT_A],
      );
      expect(after.rows[0].t).toBe(before.rows[0].t);
      expect(after.rows[0].s).toBe('VERIFIED');
    });

    // ── 14 ──
    let delegationId = '';
    let token = '';
    it('14a — the owner delegates: 201, the delegate is emailed a fragment link, only the hash is stored, audited', async () => {
      const res = await call('POST', '/v1/tenant/domain-verification/delegations', { jwt: jwt['B'], body: { delegate_email: 'IT@Bravo-P3.example' } });
      expect(res.status).toBe(201);
      expect(res.body['delegate_email']).toBe('it@bravo-p3.example');
      delegationId = res.body['id'] as string;
      token = lastToken();
      expect(sent[sent.length - 1]?.to).toBe('it@bravo-p3.example');
      expect(sent[sent.length - 1]?.text).toContain('https://sign.p3.test/domain-verification#token=');
      const row = await db.query(`SELECT token_hash, expires_at, created_at FROM identity."DomainVerificationDelegation" WHERE id = $1::uuid`, [delegationId]);
      expect(row.rows[0].token_hash).not.toBe(token);
      const ttl = new Date(row.rows[0].expires_at).getTime() - new Date(row.rows[0].created_at).getTime();
      expect(ttl).toBe(7 * 86_400_000);
      expect(await auditCount(TENANT_B, 'identity.domain.verification.delegation.issued')).toBe(1);
      const list = await call('GET', '/v1/tenant/domain-verification/delegations', { jwt: jwt['B'] });
      expect((list.body['items'] as { id: string }[]).map((i) => i.id)).toEqual([delegationId]);
      // Another tenant's admin neither sees nor revokes it.
      const otherList = await call('GET', '/v1/tenant/domain-verification/delegations', { jwt: jwt['A'] });
      expect(otherList.body['items']).toEqual([]);
      const otherRevoke = await call('DELETE', `/v1/tenant/domain-verification/delegations/${delegationId}`, { jwt: jwt['A'] });
      expect(otherRevoke.status).toBe(404);
    });

    it('14b — the delegate link shows the DNS record (the first token is minted) and records the use', async () => {
      const res = await call('POST', '/v1/domain-verification/delegate', { body: { token } });
      expect(res.status).toBe(200);
      expect(res.body['domain']).toBe(DOMAIN_B);
      expect(res.body['status']).toBe('PENDING');
      const record = res.body['record'] as { name: string; value: string };
      expect(record.name).toBe(`_aramo-challenge.${DOMAIN_B}`);
      expect(record.value).toMatch(/^aramo-domain-verification=/);
      expect(Object.keys(res.body).sort()).toEqual(['domain', 'domain_claim_conflict', 'record', 'status']);
      // A second view never rotates the token.
      const again = await call('POST', '/v1/domain-verification/delegate', { body: { token } });
      expect((again.body['record'] as { value: string }).value).toBe(record.value);
      const used = await db.query(`SELECT last_used_at FROM identity."DomainVerificationDelegation" WHERE id = $1::uuid`, [delegationId]);
      expect(used.rows[0].last_used_at).not.toBeNull();
      expect(await auditCount(TENANT_B, 'identity.domain.verification.delegation.used')).toBe(2);
    });

    it('14c — the delegate token reaches no tenant route and creates no membership', async () => {
      const members = async () =>
        (await db.query(`SELECT count(*)::int AS n FROM identity."UserTenantMembership" WHERE tenant_id = $1::uuid`, [TENANT_B])).rows[0].n as number;
      const before = await members();
      for (const [method, path] of [
        ['GET', '/v1/tenant/domain-verification'],
        ['POST', '/v1/tenant/domain-verification'],
        ['POST', '/v1/tenant/domain-verification/check'],
        ['GET', '/v1/tenant/domain-verification/delegations'],
        ['GET', '/v1/tenant/profile'],
      ] as const) {
        const r = await call(method, path, { jwt: token });
        expect(r.status).toBe(401);
      }
      expect(await members()).toBe(before);
      // The token is accepted ONLY in the body — not in the query string.
      const inQuery = await call('POST', `/v1/domain-verification/delegate?token=${encodeURIComponent(token)}`);
      expect(inQuery.status).toBe(404);
    });

    it('14d — the delegate check verifies the domain and promotes the claim', async () => {
      await publishFor(TENANT_B, DOMAIN_B);
      const res = await call('POST', '/v1/domain-verification/delegate/check', { body: { token } });
      expect(res.status).toBe(200);
      expect(res.body['status']).toBe('VERIFIED');
      expect(res.body['domain_claim_conflict']).toBe(false);
      expect(await claimOf(TENANT_B)).toEqual({ claim: 'AUTHORITATIVE', reason: 'domain_verified' });
      expect(await auditCount(TENANT_B, 'identity.domain.verified')).toBe(1);
    });

    it('14e — unknown, expired and revoked links give the same 404', async () => {
      const unknown = await call('POST', '/v1/domain-verification/delegate', { body: { token: 'A'.repeat(43) } });
      expect(unknown.status).toBe(404);
      const empty = await call('POST', '/v1/domain-verification/delegate/check', { body: {} });
      expect(empty.status).toBe(404);

      await db.query(`UPDATE identity."DomainVerificationDelegation" SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`, [delegationId]);
      const expired = await call('POST', '/v1/domain-verification/delegate', { body: { token } });
      expect(expired.status).toBe(404);
      await db.query(`UPDATE identity."DomainVerificationDelegation" SET expires_at = now() + interval '1 day' WHERE id = $1::uuid`, [delegationId]);
      expect((await call('POST', '/v1/domain-verification/delegate', { body: { token } })).status).toBe(200);

      const revoked = await call('DELETE', `/v1/tenant/domain-verification/delegations/${delegationId}`, { jwt: jwt['B'] });
      expect(revoked.status).toBe(200);
      expect(revoked.body['revoked_at']).not.toBeNull();
      expect(await auditCount(TENANT_B, 'identity.domain.verification.delegation.revoked')).toBe(1);
      const after = await call('POST', '/v1/domain-verification/delegate/check', { body: { token } });
      expect(after.status).toBe(404);
      // Same body shape for every failure (modulo the request id).
      const strip = (b: Record<string, unknown>) => JSON.stringify(b).replace(/"request_id":"[^"]*"/g, '');
      expect(strip(after.body)).toBe(strip(unknown.body));
      expect(strip(expired.body)).toBe(strip(unknown.body));
    });

    it('a VERIFIED tenant cannot issue a new delegation (409 already_verified)', async () => {
      const res = await call('POST', '/v1/tenant/domain-verification/delegations', { jwt: jwt['A'], body: { delegate_email: 'it@alpha-p3.example' } });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('already_verified');
    });
  },
);
