import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS } from '@aramo/common';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// ATS-QA-1 I-4 (L2, amendment A3) — education read through Talent 360 and recruiter
// edit (add / correct / remove), proven against real Postgres 17 + the full
// AppModule (real guards). Invariants under proof:
//   - TalentEducationEntry is the ONLY education authority, read with the same
//     tenant scope as Talent 360 (cross-tenant / missing / superseded negatives)
//   - a correction writes a NEW manual entry and RETIRES the old one: the old
//     row and its provenance are untouched history, never overwritten
//   - every change writes an audit event and the TR-7 ledger dual-write
//     (manual → ai_derived false; the retired entry's claim leaves VALID)
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
};
// identity (the write-freeze interceptor reads identity.Tenant on every write) +
// the Talent 360 boot set (talent-360.integration.spec.ts) + talent-evidence (the
// education authority) after documents (its DOC-1b migration writes into documents).
const MIGRATION_FILES: string[] = [
  ...IDENTITY_MIGRATIONS.map((p) => resolve(ROOT, p)),
  ...migrationsFor('entitlement'),
  ...migrationsFor('metering'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('consent'),
  ...migrationsFor('company'),
  ...migrationsFor('contact'),
  ...migrationsFor('requisition'),
  ...migrationsFor('talent-record'),
  ...migrationsFor('activity'),
  ...migrationsFor('calendar'),
  ...migrationsFor('saved-list'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('submittal'),
  ...migrationsFor('client-selection'),
  ...migrationsFor('placement'),
  ...migrationsFor('pre-start-requirement'),
  ...migrationsFor('task'),
  ...migrationsFor('submittal-eligibility'),
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
  ...migrationsFor('communications'),
  ...migrationsFor('talent-trust'),
  ...migrationsFor('talent-evidence'),
  ...migrationsFor('conversation-intelligence'),
];

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (!inDollar && ch === "'") {
      inString = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-qa-1-education-integration-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000004a1';
const TENANT_B = '01900000-0000-7000-8000-0000000004b2';
const SITE_A = '33333333-3333-7333-8333-3333333334aa';
const RECRUITER = '00000000-0000-7000-8000-000000004bb1';

const EDIT_SCOPES = ['talent:read', 'talent:edit'];
const READ_ONLY = ['talent:read'];
const __resolver = new ConfigurableTestResolver();

type SignKey = CryptoKey | KeyObject;

interface Res {
  status: number;
  body: any;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATS-QA-1 I-4 — education read (Talent 360) + recruiter edit (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let key: SignKey;

    let mainTalent = '';
    let otherTalent = '';
    let supersededTalent = '';
    let survivorTalent = '';
    let tenantBTalent = '';
    let resumeEntry = '';
    let otherEntry = '';
    const RESUME_DOC = randomUUID();

    async function jwt(scopes: readonly string[], tenant = TENANT_A, sub = RECRUITER): Promise<string> {
      return new SignJWT({
        sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        authz_version: __resolver.grant(tenant, sub, [...scopes]),
        site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function call(method: string, path: string, token: string, body?: unknown): Promise<Res> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) };
    }
    const t360 = async (talent: string, token: string) => call('GET', `/v1/talent-360/${talent}`, token);
    const add = async (talent: string, token: string, body: unknown) =>
      call('POST', `/v1/talent-records/${talent}/education`, token, body);
    const correct = async (talent: string, entry: string, token: string, body: unknown) =>
      call('PUT', `/v1/talent-records/${talent}/education/${entry}`, token, body);
    const remove = async (talent: string, entry: string, token: string) =>
      call('DELETE', `/v1/talent-records/${talent}/education/${entry}`, token);

    async function seedTalent(a: { tenant?: string; first: string; recordStatus?: string; supersededBy?: string | null }): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, site_id, first_name, last_name, email1, phone_cell, source, record_status, superseded_by_record_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'Person',$5,'555-0100','Referral sourcing',$6,$7,now(),now())`,
        [id, a.tenant ?? TENANT_A, SITE_A, a.first, `${id}@example.com`, a.recordStatus ?? 'live', a.supersededBy ?? null],
      );
      return id;
    }
    async function seedResumeEducation(talent: string, tenant = TENANT_A): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO talent_evidence."TalentEducationEntry"
           (id, talent_id, tenant_id, institution_name, degree_name, field_of_study, conferred_date, evidence_text, source,
            source_document_id, source_refs, source_map_version, resume_text_hash, created_at)
         VALUES ($1,$2,$3,'State Universty','BS','Computer Science','2012-05-15','BS Computer Science, State Universty 2012',
                 'resume',$4,ARRAY['b3','b4'],'v1','hash-1',now())`,
        [id, talent, tenant, RESUME_DOC],
      );
      return id;
    }
    async function entryRow(id: string) {
      const r = await db.query(`SELECT * FROM talent_evidence."TalentEducationEntry" WHERE id = $1`, [id]);
      return r.rows[0];
    }
    async function retirement(id: string) {
      const r = await db.query(`SELECT * FROM talent_evidence."EducationEntryRetirement" WHERE entry_id = $1`, [id]);
      return r.rows[0] ?? null;
    }
    async function audits(entryIds: string[]) {
      const r = await db.query(
        `SELECT * FROM talent_evidence."EducationEntryAuditEvent" WHERE entry_id = ANY($1::uuid[]) ORDER BY occurred_at, id`,
        [entryIds],
      );
      return r.rows;
    }
    async function claimsFor(entryId: string) {
      const r = await db.query(
        `SELECT id, assertion_type, dimension, source_class, method, ai_derived, current_status, created_by, assertion_payload
           FROM talent_trust."EvidenceRecord" WHERE source_ref->>'talent_evidence_id' = $1`,
        [entryId],
      );
      return r.rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATION_FILES) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          const t = s.trim();
          if (t) await db.query(t);
        }
      }
      for (const tenant of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'ATS-QA-1 I-4', now()) ON CONFLICT DO NOTHING`,
          [tenant],
        );
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [tenant],
        );
      }

      const kp = await generateKeyPair(ALG);
      key = kp.privateKey;
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__resolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      mainTalent = await seedTalent({ first: 'Main' });
      otherTalent = await seedTalent({ first: 'Other' });
      survivorTalent = await seedTalent({ first: 'Survivor' });
      supersededTalent = await seedTalent({ first: 'Old', recordStatus: 'superseded', supersededBy: survivorTalent });
      tenantBTalent = await seedTalent({ tenant: TENANT_B, first: 'Cross' });
      resumeEntry = await seedResumeEducation(mainTalent);
      otherEntry = await seedResumeEducation(otherTalent);
      await seedResumeEducation(supersededTalent);
      await seedResumeEducation(tenantBTalent, TENANT_B);
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    describe('read — Talent 360 profile.education', () => {
      it('returns the current entries from TalentEducationEntry with source and provenance refs', async () => {
        const { status, body } = await t360(mainTalent, await jwt(READ_ONLY));
        expect(status).toBe(200);
        expect(body.profile.education).toEqual([
          {
            id: resumeEntry,
            institution_name: 'State Universty',
            degree_name: 'BS',
            field_of_study: 'Computer Science',
            conferred_date: '2012-05-15',
            source: 'resume',
            source_document_id: RESUME_DOC,
            source_refs: ['b3', 'b4'],
            corrects_entry_id: null,
            recorded_at: expect.any(String),
          },
        ]);
      });

      it('another tenant cannot read the Talent (404 — the same tenant scope as Talent 360)', async () => {
        const { status } = await t360(mainTalent, await jwt(READ_ONLY, TENANT_B));
        expect(status).toBe(404);
      });

      it('a superseded record returns no education even when entries exist', async () => {
        const { status, body } = await t360(supersededTalent, await jwt(READ_ONLY));
        expect(status).toBe(200);
        expect(body.header.record_status).toBe('superseded');
        expect(body.profile.education).toEqual([]);
      });

      it('lists only the Talent’s own entries (another Talent’s entry never appears)', async () => {
        const { body } = await t360(mainTalent, await jwt(READ_ONLY));
        expect(body.profile.education.map((e: { id: string }) => e.id)).not.toContain(otherEntry);
      });
    });

    describe('edit — permissions and visibility negatives', () => {
      const valid = { institution_name: 'Night School', degree_name: 'Certificate' };

      it('talent:read alone cannot add (403) and nothing is written', async () => {
        const before = await db.query(`SELECT count(*)::int n FROM talent_evidence."TalentEducationEntry"`);
        const { status } = await add(mainTalent, await jwt(READ_ONLY), valid);
        expect(status).toBe(403);
        const after = await db.query(`SELECT count(*)::int n FROM talent_evidence."TalentEducationEntry"`);
        expect(after.rows[0].n).toBe(before.rows[0].n);
      });

      it('another tenant cannot add to, correct or remove this Talent’s education (404, nothing written)', async () => {
        const tokenB = await jwt(EDIT_SCOPES, TENANT_B);
        expect((await add(mainTalent, tokenB, valid)).status).toBe(404);
        expect((await correct(mainTalent, resumeEntry, tokenB, valid)).status).toBe(404);
        expect((await remove(mainTalent, resumeEntry, tokenB)).status).toBe(404);
        expect(await retirement(resumeEntry)).toBeNull();
      });

      it('an entry of another Talent cannot be reached through this Talent (404)', async () => {
        const token = await jwt(EDIT_SCOPES);
        expect((await correct(mainTalent, otherEntry, token, valid)).status).toBe(404);
        expect((await remove(mainTalent, otherEntry, token)).status).toBe(404);
        expect(await retirement(otherEntry)).toBeNull();
      });

      it('a Talent that does not exist is 404; a superseded record is read-only (422)', async () => {
        const token = await jwt(EDIT_SCOPES);
        expect((await add(randomUUID(), token, valid)).status).toBe(404);
        const r = await add(supersededTalent, token, valid);
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('TALENT_RECORD_SUPERSEDED');
      });

      it('refuses a missing degree, an impossible date and a partial date (400)', async () => {
        const token = await jwt(EDIT_SCOPES);
        expect((await add(mainTalent, token, { institution_name: 'X' })).status).toBe(400);
        expect((await add(mainTalent, token, { ...valid, conferred_date: '2023-02-31' })).status).toBe(400);
        expect((await add(mainTalent, token, { ...valid, conferred_date: '2012' })).status).toBe(400);
      });
    });

    describe('edit — add, correct, remove keep history, provenance, audit and the ledger', () => {
      let added = '';
      let corrected = '';

      it('add writes a manual entry, an audit event and a ledger claim with ai_derived false', async () => {
        const { status, body } = await add(mainTalent, await jwt(EDIT_SCOPES), {
          institution_name: '  Community College ',
          degree_name: 'AA',
          field_of_study: '',
          conferred_date: '2008-06-01',
        });
        expect(status).toBe(201);
        added = body.entry_id;
        const entry = body.education.find((e: { id: string }) => e.id === added);
        expect(entry).toMatchObject({
          institution_name: 'Community College',
          degree_name: 'AA',
          field_of_study: null,
          conferred_date: '2008-06-01',
          source: 'manual',
          source_document_id: null,
          source_refs: [],
          corrects_entry_id: null,
        });
        const ev = await audits([added]);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ action: 'added', actor_id: RECRUITER, tenant_id: TENANT_A });
        const claims = await claimsFor(added);
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({
          assertion_type: 'DEGREE',
          dimension: 'CLAIMS',
          source_class: 'THIRD_PARTY_UNVERIFIED',
          method: 'DOCUMENT',
          ai_derived: false,
          current_status: 'VALID',
          created_by: 'talent-education-edit',
        });
      });

      it('correcting the resume entry writes a new manual entry and retires the old one — the old row and its provenance are untouched', async () => {
        const before = await entryRow(resumeEntry);
        const { status, body } = await correct(mainTalent, resumeEntry, await jwt(EDIT_SCOPES), {
          institution_name: 'State University',
          degree_name: 'BS',
          field_of_study: 'Computer Science',
          conferred_date: '2012-05-15',
        });
        expect(status).toBe(200);
        corrected = body.entry_id;
        expect(corrected).not.toBe(resumeEntry);

        // The current list carries the correction, not the superseded entry.
        const ids = body.education.map((e: { id: string }) => e.id);
        expect(ids).toContain(corrected);
        expect(ids).not.toContain(resumeEntry);
        const now = body.education.find((e: { id: string }) => e.id === corrected);
        expect(now).toMatchObject({ institution_name: 'State University', source: 'manual', corrects_entry_id: resumeEntry });

        // History: the extracted row is byte-for-byte unchanged (never overwritten).
        expect(await entryRow(resumeEntry)).toEqual(before);
        expect(before.source).toBe('resume');
        expect(before.source_refs).toEqual(['b3', 'b4']);
        expect(before.source_document_id).toBe(RESUME_DOC);
        expect(await retirement(resumeEntry)).toMatchObject({
          reason: 'corrected',
          superseded_by_entry_id: corrected,
          retired_by_id: RECRUITER,
        });

        // Audit: one corrected event naming the changed field only (no values).
        const ev = await audits([corrected]);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ action: 'corrected', actor_id: RECRUITER, related_entry_id: resumeEntry });
        expect(ev[0].changed_fields).toEqual(['institution_name']);

        // Ledger: the extracted entry's claim (written as the extraction producer
        // writes it) is SUPERSEDED by the manual correction's claim (ai_derived false).
        const old = await claimsFor(resumeEntry);
        expect(old).toHaveLength(1);
        expect(old[0]).toMatchObject({ ai_derived: true, current_status: 'SUPERSEDED' });
        const fresh = await claimsFor(corrected);
        expect(fresh).toHaveLength(1);
        expect(fresh[0]).toMatchObject({ ai_derived: false, current_status: 'VALID' });
        expect(fresh[0].assertion_payload).toMatchObject({ institution_raw: 'State University', degree_raw: 'BS' });
        const link = await db.query(
          `SELECT relation FROM talent_trust."EvidenceLink" WHERE from_evidence_id = $1 AND to_evidence_id = $2`,
          [fresh[0].id, old[0].id],
        );
        expect(link.rows.map((r) => r.relation)).toEqual(['SUPERSEDES']);
      });

      it('Talent 360 shows the correction and no longer shows the superseded entry', async () => {
        const { body } = await t360(mainTalent, await jwt(READ_ONLY));
        const ids = body.profile.education.map((e: { id: string }) => e.id);
        expect(ids).toEqual(expect.arrayContaining([corrected, added]));
        expect(ids).not.toContain(resumeEntry);
      });

      it('an already-corrected entry cannot be corrected or removed again (409, nothing written)', async () => {
        const token = await jwt(EDIT_SCOPES);
        const count = async () =>
          (await db.query(`SELECT count(*)::int n FROM talent_evidence."TalentEducationEntry" WHERE talent_id = $1`, [mainTalent])).rows[0].n;
        const before = await count();
        expect((await correct(mainTalent, resumeEntry, token, { institution_name: 'Y', degree_name: 'Z' })).status).toBe(409);
        expect((await remove(mainTalent, resumeEntry, token)).status).toBe(409);
        expect(await count()).toBe(before);
      });

      it('an unchanged correction writes nothing', async () => {
        const n = (await audits([corrected])).length;
        const { status, body } = await correct(mainTalent, corrected, await jwt(EDIT_SCOPES), {
          institution_name: 'State University',
          degree_name: 'BS',
          field_of_study: 'Computer Science',
          conferred_date: '2012-05-15',
        });
        expect(status).toBe(200);
        expect(body.entry_id).toBe(corrected);
        expect(await retirement(corrected)).toBeNull();
        expect((await audits([corrected])).length).toBe(n);
      });

      it('remove retires the entry (kept as history), writes an audit event and revokes its claim', async () => {
        const { status, body } = await remove(mainTalent, added, await jwt(EDIT_SCOPES));
        expect(status).toBe(200);
        expect(body.education.map((e: { id: string }) => e.id)).not.toContain(added);
        expect(await entryRow(added)).toMatchObject({ institution_name: 'Community College', source: 'manual' });
        expect(await retirement(added)).toMatchObject({ reason: 'removed', superseded_by_entry_id: null, retired_by_id: RECRUITER });
        const ev = await audits([added]);
        expect(ev.map((e) => e.action)).toEqual(['added', 'removed']);
        const claims = await claimsFor(added);
        expect(claims).toHaveLength(1);
        expect(claims[0].current_status).toBe('REVOKED');
      });

      it('two concurrent corrections of the same entry: exactly one wins, the other is 409', async () => {
        const token = await jwt(EDIT_SCOPES);
        const target = (await add(mainTalent, token, { institution_name: 'Race U', degree_name: 'MS' })).body.entry_id as string;
        const [a, b] = await Promise.all([
          correct(mainTalent, target, token, { institution_name: 'Race University', degree_name: 'MS' }),
          correct(mainTalent, target, token, { institution_name: 'Race Univ.', degree_name: 'MS' }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const replacements = await db.query(
          `SELECT count(*)::int n FROM talent_evidence."EducationEntryAuditEvent" WHERE related_entry_id = $1 AND action = 'corrected'`,
          [target],
        );
        expect(replacements.rows[0].n).toBe(1);
        const valid = (await claimsFor(target)).filter((c) => c.current_status === 'VALID');
        expect(valid).toHaveLength(0);
      });

      it('the extraction ledger routing never reads manual entries (their claims are ai_derived false only)', async () => {
        const repo = module.get(TalentEvidenceRepository, { strict: false });
        const rows = await repo.listEducationForLedger({ tenant_id: TENANT_A, talent_id: mainTalent });
        expect(rows.map((r) => r.id)).toEqual([resumeEntry]);
      });

      it('another tenant’s education is untouched by every edit above', async () => {
        const r = await db.query(
          `SELECT count(*)::int n FROM talent_evidence."EducationEntryRetirement" WHERE tenant_id = $1`,
          [TENANT_B],
        );
        expect(r.rows[0].n).toBe(0);
      });
    });
  },
);
