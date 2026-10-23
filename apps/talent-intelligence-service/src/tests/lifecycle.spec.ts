import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  GOV_ID_TOKENIZER,
  GovIdTokenizer,
  INTELLIGENCE_UNIT_OF_WORK,
  IntelligencePrismaService,
  VERIFICATION_CODE_SERVICE,
  VerificationCodeService,
  hashClientSecret,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type UnitOfWorkOptions,
} from '@aramo/intelligence-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only in-memory fake shared with the core specs
import { InMemoryIntelligence } from '../../../../libs/intelligence-core/src/tests/support/in-memory-intelligence.js';

// ATI-SEP-1 T10 — the HTTP surface of the evidence lifecycle on the real
// AppModule (in-memory unit of work): routes, per-route scopes (intelligence:
// disputes / proposals / verify), status codes and the tenant access matrix.

const ENV = {
  INTELLIGENCE_SERVICE_TOKEN_SECRET: 't'.repeat(48),
  INTELLIGENCE_DATABASE_URL: 'postgresql://boot:test@127.0.0.1:1/aramo_intelligence',
  TI_OUTBOX_DRAIN_ENABLED: '0',
  TI_REASSESSMENT_ENABLED: '0',
  TI_CROSS_TENANT_READ_ENABLED: 'false',
};
const SCOPES = {
  ats: ['intelligence:ingest', 'intelligence:entitlements', 'intelligence:disputes', 'intelligence:proposals', 'intelligence:verify'],
  readOnly: ['intelligence:read'],
} as const;
const A1 = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-1' };
const VERIFIED = { status: 'VERIFIED', method: 'EMAIL_OTP', source: 'ARAMO_PORTAL', verified_at: '2026-10-01T00:00:00.000Z' };

describe('talent-intelligence-service — T10 evidence lifecycle', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let mem: InMemoryIntelligence;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (who: keyof typeof SCOPES) => ({ Authorization: `Bearer ${tokens[who]}` });
  const titleOf = (value: string) => [...mem.state.assertions.values()].find((a) => (a.payload as { value?: string }).value === value)?.id as string;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    mem = new InMemoryIntelligence();
    const uow: IntelligenceUnitOfWork = { run: <T>(fn: (r: IntelligenceRepositories) => Promise<T>, o?: UnitOfWorkOptions) => mem.run(fn, o) };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IntelligencePrismaService)
      .useValue({ ping: async () => true, $disconnect: async () => undefined, onModuleDestroy: async () => undefined })
      .overrideProvider(INTELLIGENCE_UNIT_OF_WORK)
      .useValue(uow)
      .overrideProvider(GOV_ID_TOKENIZER)
      .useValue(GovIdTokenizer.withKey('g'.repeat(32)))
      .overrideProvider(VERIFICATION_CODE_SERVICE)
      .useValue(VerificationCodeService.withKey('c'.repeat(32)))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await mem.run(async (r) => {
      for (const [id, scopes] of Object.entries(SCOPES)) {
        await r.clients.upsert({ client_id: id, secret_hash: hashClientSecret(`${id}-secret`), allowed_scopes: [...scopes], source_system_id: 'ARAMO_ATS', active: true });
      }
    });
    for (const id of Object.keys(SCOPES)) {
      const res = await http().post('/v1/oauth/token').send({ grant_type: 'client_credentials', client_id: id, client_secret: `${id}-secret` });
      tokens[id] = res.body.access_token as string;
    }
    await http()
      .post('/v1/entitlements/sync')
      .set(bearer('ats'))
      .send({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'tenant-a', active: true }, { tenant_id: 'tenant-c', active: true }] })
      .expect(200);
    const ingest = (talent: string, title: string, at: string) =>
      http()
        .post('/v1/ingest/talent')
        .set(bearer('ats'))
        .send({
          source_system_id: 'ARAMO_ATS',
          source_tenant_id: 'tenant-a',
          external_talent_id: talent,
          source_event_id: randomUUID(),
          occurred_at: at,
          identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'priya@x.io', is_primary: true, verification: VERIFIED }] },
          assertions: [{ assertion_type: 'TITLE', payload: { value: title }, source_kind: 'RECRUITER', observed_at: at }],
        })
        .expect(200);
    await ingest('a-1', 'Engineer', '2026-10-01T00:00:00.000Z');
    await ingest('a-2', 'Manager', '2026-10-05T00:00:00.000Z');
  });

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('every T10 route requires its scope (403 with a read-only token, 401 without one)', async () => {
    const id = randomUUID();
    // Built lazily: a supertest request binds the server when it is created.
    const calls = [
      () => http().post('/v1/disputes').send({}),
      () => http().get('/v1/disputes?reference=ARAMO_ATS/tenant-a/a-1'),
      () => http().post(`/v1/disputes/${id}/triage`).send({}),
      () => http().get('/v1/tenants/tenant-a/disputes'),
      () => http().get('/v1/tenants/tenant-a/proposals'),
      () => http().post(`/v1/proposals/${id}/dismiss`).send({}),
      () => http().post(`/v1/references/ARAMO_ATS/tenant-a/a-1/assertions/${id}/contradiction-resolution`).send({}),
      () => http().get('/v1/references/ARAMO_ATS/tenant-a/a-1/verifications'),
      () => http().get('/v1/verifications?reference=ARAMO_ATS/tenant-a/a-1'),
    ];
    for (const c of calls) expect((await c().set(bearer('readOnly'))).status).toBe(403);
    expect((await http().get('/v1/tenants/tenant-a/disputes')).status).toBe(401);
  });

  it('dispute lifecycle over HTTP: open 201 → tenant list → triage → uphold; 403 unentitled, 404 tenant without a reference', async () => {
    const eng = titleOf('Engineer');
    const opened = await http().post('/v1/disputes').set(bearer('ats')).send({ portal_context: A1, assertion_id: eng, statement: 'Not my title.' });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ assertion_id: eng, status: 'OPEN', assertion_type: 'TITLE' });
    const id = opened.body.dispute_id as string;
    const portal = await http().get(`/v1/disputes?reference=${encodeURIComponent('ARAMO_ATS/tenant-a/a-1')}`).set(bearer('ats'));
    expect(portal.body.items.map((i: { dispute_id: string }) => i.dispute_id)).toEqual([id]);
    expect((await http().get('/v1/disputes').set(bearer('ats'))).status).toBe(400);

    const list = await http().get('/v1/tenants/tenant-a/disputes').set(bearer('ats'));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { dispute_id: string }) => i.dispute_id)).toEqual([id]);
    expect((await http().get('/v1/tenants/tenant-b/disputes').set(bearer('ats'))).body.error.code).toBe('NOT_ENTITLED');
    expect((await http().get(`/v1/tenants/tenant-c/disputes/${id}`).set(bearer('ats'))).status).toBe(404);
    expect((await http().get('/v1/tenants/bad%20tenant/disputes').set(bearer('ats'))).status).toBe(400);

    const early = await http().post(`/v1/disputes/${id}/uphold`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1', note: 'n' });
    expect([early.status, early.body.error.code]).toEqual([422, 'DISPUTE_NOT_UNDER_REVIEW']);
    const triaged = await http().post(`/v1/disputes/${id}/triage`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1' });
    expect([triaged.status, triaged.body]).toEqual([200, { dispute_id: id, status: 'UNDER_REVIEW' }]);
    const evidence = mem.state.assertions.get(eng);
    expect(evidence?.current_status).toBe('DISPUTED');
    const upheld = await http().post(`/v1/disputes/${id}/uphold`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1', note: 'Confirmed.' });
    expect(upheld.body).toEqual({ dispute_id: id, status: 'RESOLVED_UPHELD' });
    const detail = await http().get(`/v1/tenants/tenant-a/disputes/${id}`).set(bearer('ats'));
    expect(detail.body).toMatchObject({ status: 'RESOLVED_UPHELD', resolution_note: 'Confirmed.', external_talent_ids: ['a-1', 'a-2'], contributed_by: 'REQUESTING_TENANT' });
    expect((await http().post(`/v1/disputes/${id}/extend`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1' })).status).toBe(200);
    expect((await http().post(`/v1/disputes/${id}/extend`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1' })).body.error.code).toBe('DISPUTE_EXTENSION_USED');
  });

  it('proposals list / dismiss / act and contradiction resolution over HTTP', async () => {
    const list = await http().get('/v1/tenants/tenant-a/proposals').set(bearer('ats'));
    expect(list.status).toBe(200);
    // Single tenant source → VERIFY_CONTACT (EMAIL). Engineer's RESOLVE_CONTRADICTION was SETTLED while it was
    // DISPUTED (the trigger cleared) and a settled basis is never re-opened (legacy semantics) → only Manager's is open.
    const items = list.body.items as Array<{ kind: string; proposal_id: string; assertion_id: string }>;
    expect(items.map((p) => [p.kind, p.assertion_id])).toEqual([
      ['VERIFY_CONTACT', null],
      ['RESOLVE_CONTRADICTION', titleOf('Manager')],
    ]);
    const mgr = items.find((p) => p.assertion_id === titleOf('Manager')) as { proposal_id: string };
    const dismissed = await http().post(`/v1/proposals/${mgr.proposal_id}/dismiss`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1', justification: 'Known.' });
    expect(dismissed.body).toMatchObject({ status: 'DISMISSED', justification: 'Known.' });
    const again = await http().post(`/v1/proposals/${mgr.proposal_id}/act`).set(bearer('ats')).send({ source_tenant_id: 'tenant-a', actor: 'u1', action: 'CONTRADICTION_RESOLVED' });
    expect([again.status, again.body.error.code]).toEqual([409, 'PROPOSAL_NOT_OPEN']);
    expect((await http().get('/v1/tenants/tenant-a/proposals?status=NOPE').set(bearer('ats'))).status).toBe(400);

    const eng = titleOf('Engineer');
    const path = `/v1/references/ARAMO_ATS/tenant-a/a-1/assertions/${eng}/contradiction-resolution`;
    expect((await http().post(path).set(bearer('ats')).send({ resolution: 'KEEP', reason: 'r' })).status).toBe(400);
    const resolved = await http().post(path).set(bearer('ats')).send({ resolution: 'KEEP', reason: 'Both held at once.', actor: 'u1' });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ assertion_id: eng, resolution: 'KEEP', status: 'VALID', reconciled_with: [titleOf('Manager')] });
    expect((await http().post(path).set(bearer('ats')).send({ resolution: 'KEEP', reason: 'x', actor: 'u1' })).body.error.code).toBe('ASSERTION_NOT_CONTRADICTED');
    // Manager's proposal was dismissed; nothing is contradicted any more → only VERIFY_CONTACT (EMAIL) stays open.
    const after = await http().get('/v1/tenants/tenant-a/proposals').set(bearer('ats'));
    expect((after.body.items as Array<{ kind: string; identifier_type: string }>).map((p) => [p.kind, p.identifier_type])).toEqual([['VERIFY_CONTACT', 'EMAIL']]);
    const settled = await http().get('/v1/tenants/tenant-a/proposals?status=SETTLED').set(bearer('ats'));
    expect((settled.body.items as Array<{ assertion_id: string }>).map((p) => p.assertion_id)).toEqual([eng]);
  });

  it('verification status: GET …/verifications (M-1) and GET /v1/verifications?reference= (M-6)', async () => {
    const m1 = await http().get('/v1/references/ARAMO_ATS/tenant-a/a-1/verifications').set(bearer('ats'));
    expect(m1.status).toBe(200);
    expect(m1.body.items).toEqual([{ identifier_type: 'EMAIL', value_masked: 'p***@x.io', status: 'VERIFIED', expires_at: '2027-10-01T00:00:00.000Z' }]);
    expect((await http().get('/v1/references/ARAMO_ATS/tenant-a/nope/verifications').set(bearer('ats'))).status).toBe(404);
    const m6 = await http().get('/v1/verifications?reference=ARAMO_ATS/tenant-a/a-1&reference=ARAMO_ATS/tenant-a/a-2').set(bearer('ats'));
    expect(m6.status).toBe(200);
    expect(m6.body.items).toHaveLength(1);
    expect(m6.body.items[0]).toMatchObject({ identifier_type: 'EMAIL', status: 'VERIFIED', assertion_id: null });
    expect((await http().get('/v1/verifications?reference=bad').set(bearer('ats'))).status).toBe(400);
  });
});
