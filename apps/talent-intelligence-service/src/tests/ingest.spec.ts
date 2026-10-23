import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  GOV_ID_TOKENIZER,
  GovIdTokenizer,
  INTELLIGENCE_UNIT_OF_WORK,
  IntelligencePrismaService,
  hashClientSecret,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type UnitOfWorkOptions,
} from '@aramo/intelligence-core';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only in-memory fake shared with the core specs
import { InMemoryIntelligence } from '../../../../libs/intelligence-core/src/tests/support/in-memory-intelligence.js';

// ATI-SEP-1 T2 — the HTTP surface of the TI service on the real AppModule, with
// the database swapped for the in-memory unit of work: token exchange, the
// bearer guard, ingestion status codes and idempotent replay.

const SECRET_ENV = 'INTELLIGENCE_SERVICE_TOKEN_SECRET';
const DB_ENV = 'INTELLIGENCE_DATABASE_URL';

function body(over: Record<string, unknown> = {}) {
  return {
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: 'tenant-a',
    external_talent_id: 'talent-1',
    source_event_id: randomUUID(),
    occurred_at: '2026-10-23T10:00:00.000Z',
    identity: {
      names: { first: 'Priya', last: 'Raman' },
      emails: [{ value: 'priya@example.com', is_primary: true }],
    },
    assertions: [{ assertion_type: 'SKILL', payload: { name: 'TypeScript' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00.000Z' }],
    ...over,
  };
}

describe('talent-intelligence-service — token exchange + ingestion', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let mem: InMemoryIntelligence;
  let token: string;

  beforeAll(async () => {
    for (const k of [SECRET_ENV, DB_ENV, 'TI_OUTBOX_DRAIN_ENABLED', 'TI_REASSESSMENT_ENABLED']) saved[k] = process.env[k];
    process.env['TI_OUTBOX_DRAIN_ENABLED'] = '0';
    process.env['TI_REASSESSMENT_ENABLED'] = '0';
    process.env[SECRET_ENV] = 't'.repeat(48);
    process.env[DB_ENV] = 'postgresql://boot:test@127.0.0.1:1/aramo_intelligence';
    mem = new InMemoryIntelligence();
    const uow: IntelligenceUnitOfWork = {
      run: <T>(fn: (r: IntelligenceRepositories) => Promise<T>, o?: UnitOfWorkOptions) => mem.run(fn, o),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IntelligencePrismaService)
      .useValue({ ping: async () => true, $disconnect: async () => undefined })
      .overrideProvider(INTELLIGENCE_UNIT_OF_WORK)
      .useValue(uow)
      .overrideProvider(GOV_ID_TOKENIZER)
      .useValue(GovIdTokenizer.withKey('g'.repeat(32)))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await mem.run(async (r) => {
      await r.clients.upsert({ client_id: 'ats', secret_hash: hashClientSecret('ats-secret'), allowed_scopes: ['intelligence:ingest'], source_system_id: 'ARAMO_ATS', active: true });
      await r.clients.upsert({ client_id: 'reader', secret_hash: hashClientSecret('r'), allowed_scopes: ['intelligence:read'], source_system_id: 'ARAMO_ATS', active: true });
    });
    const res = await request(app.getHttpServer())
      .post('/v1/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'ats-secret' });
    expect(res.status).toBe(200);
    token = res.body.access_token as string;
  });

  const http = () => request(app.getHttpServer());

  describe('POST /v1/oauth/token', () => {
    it('accepts HTTP Basic + JSON and sets Cache-Control: no-store', async () => {
      const res = await http()
        .post('/v1/oauth/token')
        .set('Authorization', `Basic ${Buffer.from('ats:ats-secret').toString('base64')}`)
        .send({ grant_type: 'client_credentials' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 300, scope: 'intelligence:ingest' });
    });

    it('OAuth error shapes: 401 invalid_client, 400 unsupported_grant_type', async () => {
      const bad = await http().post('/v1/oauth/token').send({ grant_type: 'client_credentials', client_id: 'ats', client_secret: 'no' });
      expect(bad.status).toBe(401);
      expect(bad.body).toMatchObject({ error: 'invalid_client' });
      const grant = await http().post('/v1/oauth/token').send({ grant_type: 'password', client_id: 'ats', client_secret: 'ats-secret' });
      expect(grant.status).toBe(400);
      expect(grant.body).toMatchObject({ error: 'unsupported_grant_type' });
    });
  });

  describe('POST /v1/ingest/talent', () => {
    it('401 without / with a bad bearer token; 403 without the ingest scope', async () => {
      expect((await http().post('/v1/ingest/talent').send(body())).status).toBe(401);
      expect((await http().post('/v1/ingest/talent').set('Authorization', 'Bearer nope').send(body())).status).toBe(401);
      const reader = await http().post('/v1/oauth/token').send({ grant_type: 'client_credentials', client_id: 'reader', client_secret: 'r' });
      const res = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${reader.body.access_token as string}`).send(body());
      expect(res.status).toBe(403);
    });

    it('200 CREATED, then the same event replays its stored outcome', async () => {
      const b = body();
      const first = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send(b);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ outcome: 'CREATED', resolution: 'NEW_PROVISIONAL', assertions_added: 2, replayed: false });
      const again = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send(b);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ...first.body, replayed: true });
    });

    it.each([
      ['DOCUMENT_REJECTED', { attachments: [{ storage_key: 'k' }] }],
      ['CLASS_C_REJECTED', { desired_pay: 100 }],
      ['INVALID_REQUEST', { surprise: true }],
    ])('400 %s (quarantined)', async (code, extra) => {
      const before = mem.state.quarantine.length;
      const res = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send(body(extra));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(mem.state.quarantine).toHaveLength(before + 1);
    });

    it('409 when an event id is reused for another reference', async () => {
      const b = body();
      await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send(b);
      const res = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send({ ...b, external_talent_id: 'other' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_ID_REUSED');
    });
  });

  describe('POST /v1/ingest/talent/erased', () => {
    it('erases the reference and reports the subject AUDIT_RETAINED', async () => {
      const b = body({ external_talent_id: 'to-erase' });
      const created = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send(b);
      const res = await http()
        .post('/v1/ingest/talent/erased')
        .set('Authorization', `Bearer ${token}`)
        .send({ source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'to-erase', source_event_id: randomUUID(), occurred_at: '2026-10-24T00:00:00.000Z' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ outcome: 'ERASED', intelligence_subject_id: created.body.intelligence_subject_id, subject_access_state: 'AUDIT_RETAINED' });
      const after = await http().post('/v1/ingest/talent').set('Authorization', `Bearer ${token}`).send({ ...b, source_event_id: randomUUID() });
      expect(after.status).toBe(409);
      expect(after.body.error.code).toBe('REFERENCE_ERASED');
    });
  });
});
