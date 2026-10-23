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

// ATI-SEP-1 T4/T6 — the HTTP surface of verification, the read API and
// entitlement sync on the real AppModule (in-memory unit of work): per-route
// scopes, status codes, and the read access matrix at the HTTP layer.

const ENV = {
  INTELLIGENCE_SERVICE_TOKEN_SECRET: 't'.repeat(48),
  INTELLIGENCE_DATABASE_URL: 'postgresql://boot:test@127.0.0.1:1/aramo_intelligence',
  TI_OUTBOX_DRAIN_ENABLED: '0',
  TI_REASSESSMENT_ENABLED: '0',
  TI_CROSS_TENANT_READ_ENABLED: 'false',
};
const codes = VerificationCodeService.withKey('c'.repeat(32));
const SCOPES = {
  ats: ['intelligence:ingest', 'intelligence:read', 'intelligence:entitlements'],
  portal: ['intelligence:verify'],
  ingestOnly: ['intelligence:ingest'],
} as const;

describe('talent-intelligence-service — verification, read API, entitlements', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let mem: InMemoryIntelligence;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (who: keyof typeof SCOPES) => ({ Authorization: `Bearer ${tokens[who]}` });

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
      .useValue(codes)
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
    const ingest = (tenant: string, talent: string, skill: string) =>
      http()
        .post('/v1/ingest/talent')
        .set(bearer('ats'))
        .send({
          source_system_id: 'ARAMO_ATS',
          source_tenant_id: tenant,
          external_talent_id: talent,
          source_event_id: randomUUID(),
          occurred_at: '2026-10-23T10:00:00.000Z',
          identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'priya@x.io', is_primary: true, verification: { status: 'VERIFIED', method: 'EMAIL_OTP', source: 'ARAMO_PORTAL', verified_at: '2026-10-01T00:00:00.000Z' } }] },
          assertions: [{ assertion_type: 'SKILL', payload: { name: skill }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00.000Z' }],
        })
        .expect(200);
    await ingest('tenant-a', 'a-1', 'TypeScript');
    await ingest('tenant-b', 'b-1', 'Go');
  });

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('POST /v1/entitlements/sync — scope intelligence:entitlements, closed body', async () => {
    await http().post('/v1/entitlements/sync').set(bearer('ingestOnly')).send({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [] }).expect(403);
    const bad = await http().post('/v1/entitlements/sync').set(bearer('ats')).send({ source_system_id: 'ARAMO_ATS', mode: 'MERGE', tenants: [] });
    expect(bad.status).toBe(400);
    const ok = await http().post('/v1/entitlements/sync').set(bearer('ats')).send({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'tenant-a', active: true }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ applied: 1, deactivated: 0 });
  });

  it('GET …/profile — 401 / 403 scope / 403 NOT_ENTITLED / 404 / 200 tenant-scoped', async () => {
    const path = '/v1/references/ARAMO_ATS/tenant-a/a-1/profile';
    await http().get(path).expect(401);
    await http().get(path).set(bearer('ingestOnly')).expect(403);
    const unentitled = await http().get('/v1/references/ARAMO_ATS/tenant-b/b-1/profile').set(bearer('ats'));
    expect(unentitled.status).toBe(403);
    expect(unentitled.body.error.code).toBe('NOT_ENTITLED');
    const missing = await http().get('/v1/references/ARAMO_ATS/tenant-a/nope/profile').set(bearer('ats'));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('REFERENCE_NOT_FOUND');
    const ok = await http().get(path).set(bearer('ats'));
    expect(ok.status).toBe(200);
    expect(ok.body.access_mode).toBe('TENANT_SCOPED');
    expect((ok.body.facts as Array<{ fact_type: string; fact_key: string }>).filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['typescript']);
    const evidence = await http().get('/v1/references/ARAMO_ATS/tenant-a/a-1/evidence').set(bearer('ats'));
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(evidence.body)).not.toContain('tenant-b');
    expect((await http().get('/v1/references/ARAMO_ATS/tenant-a/a-1/artifacts').set(bearer('ats'))).body.artifacts).toEqual([]);
    expect(mem.state.readAudit.map((r) => r.outcome)).toEqual(['NOT_ENTITLED', 'REFERENCE_NOT_FOUND', 'GRANTED', 'GRANTED', 'GRANTED']);
  });

  it('there is no by-subject route', async () => {
    const subject = [...mem.state.subjects.keys()][0] as string;
    await http().get(`/v1/subjects/${subject}/profile`).set(bearer('ats')).expect(404);
  });

  it('POST /v1/verifications → 201; confirm → 422 INVALID_CODE … 200 BOUND → 409', async () => {
    const ref = { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-1' };
    await http().post('/v1/verifications').set(bearer('ats')).send({ source_reference: ref, identifier_type: 'EMAIL', value: 'p2@x.io' }).expect(403);
    const created = await http().post('/v1/verifications').set(bearer('portal')).send({ source_reference: ref, identifier_type: 'EMAIL', value: 'p2@x.io' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ channel: 'EMAIL', status: 'PENDING', delivery: 'QUEUED' });
    const id = created.body.verification_id as string;
    const row = mem.state.verifications.get(id) as NonNullable<ReturnType<typeof mem.state.verifications.get>>;
    const code = codes.codeFor(row.id, row.code_salt);
    const wrong = await http().post(`/v1/verifications/${id}/confirm`).set(bearer('portal')).send({ code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toMatchObject({ code: 'INVALID_CODE', attempts_remaining: 4 });
    const ok = await http().post(`/v1/verifications/${id}/confirm`).set(bearer('portal')).send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ verification_id: id, status: 'CONFIRMED', outcome: 'BOUND' });
    expect((await http().post(`/v1/verifications/${id}/confirm`).set(bearer('portal')).send({ code })).status).toBe(409);
    expect((await http().post(`/v1/verifications/${randomUUID()}/confirm`).set(bearer('portal')).send({ code })).status).toBe(404);
    expect((await http().post('/v1/verifications/not-a-uuid/confirm').set(bearer('portal')).send({ code })).status).toBe(400);
    const sms = await http().post('/v1/verifications').set(bearer('portal')).send({ source_reference: ref, identifier_type: 'PHONE', value: '+15550102000' });
    expect(sms.body).toMatchObject({ channel: 'SMS', delivery: 'NOT_AVAILABLE' });
  });
});
