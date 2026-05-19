import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentEvidenceRepository } from '../lib/talent-evidence.repository.js';

// M3 PR-5 integration test. Brings up a Postgres testcontainer, applies the
// init migration, and asserts:
//
//   - Each of the 7 entities persists and reads back round-trip;
//   - talent_id / tenant_id and the forward-reference UUID columns
//     (skill_id, source_record_id, source_document_id,
//     uploaded_by_actor_id) round-trip verbatim;
//   - TalentRateExpectation.employment_type "1099" — the §2.2 literal that
//     the schema's @map renames at the Prisma identifier layer — round-trips
//     as the spec literal "1099" through the repository's translation;
//   - TalentEngagementEvent is NOT present on the Prisma client (the 8th
//     EvidenceReference target is deferred to M5 per directive §2 Ruling 1);
//   - The migration emits zero FOREIGN KEY / REFERENCES — verified by
//     inserting an entity whose UUID references point at non-existent rows
//     (no insert failure; the application layer is responsible for
//     referential integrity per Architecture §7.3).

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
);

// All test UUIDs use hex-only characters per RFC 4122. Tags chosen for
// mnemonic clarity within the hex set: 1=tenant, 2=skill, 3=source-record,
// 4=document, 5=actor, a=talent, b=rate (b≈bill), c=contact, d=doc-suffix,
// e=evidence, f=work-history (w→f). Non-hex initials ('s', 'r', 'w') are
// avoided.
const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const SKILL = '22222222-2222-7222-8222-222222222222';
const SKILL_SOURCE_RECORD = '33333333-3333-7333-8333-333333333333';
const DOC_ID = '44444444-4444-7444-8444-444444444444';
const ACTOR = '55555555-5555-7555-8555-555555555555';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentEvidenceRepository — schema integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentEvidenceRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of migrationSql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentEvidenceRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('persists and reads back TalentSkillEvidence with skill_id + source_record_id forward refs (§2.2 #16)', async () => {
      const created = await repo.createTalentSkillEvidence({
        id: '00000000-0000-7000-8000-0000000000e1',
        talent_id: TALENT,
        tenant_id: TENANT,
        skill_id: SKILL,
        source_record_id: SKILL_SOURCE_RECORD,
        surface_form: 'TypeScript',
        source: 'ingested',
        evidence_text: 'Built three production TypeScript services',
        proficiency_claim: 'expert',
        years_claimed: 7.5,
        confidence_score: 0.92,
        created_at: new Date('2026-05-19T10:00:00Z'),
      });

      expect(created.skill_id).toBe(SKILL);
      expect(created.source_record_id).toBe(SKILL_SOURCE_RECORD);
      expect(created.source).toBe('ingested');

      const read = await repo.findTalentSkillEvidenceById(created.id);
      expect(read?.skill_id).toBe(SKILL);
      expect(read?.source_record_id).toBe(SKILL_SOURCE_RECORD);
      expect(read?.years_claimed).toBe(7.5);
      expect(read?.confidence_score).toBe(0.92);
    });

    it('persists TalentSkillEvidence without optional fields (round-trip null forward ref + nullables)', async () => {
      const created = await repo.createTalentSkillEvidence({
        id: '00000000-0000-7000-8000-0000000000e2',
        talent_id: TALENT,
        tenant_id: TENANT,
        skill_id: SKILL,
        surface_form: 'AWS',
        source: 'declared',
        created_at: new Date('2026-05-19T10:00:00Z'),
      });

      const read = await repo.findTalentSkillEvidenceById(created.id);
      expect(read?.source_record_id).toBeNull();
      expect(read?.evidence_text).toBeNull();
      expect(read?.years_claimed).toBeNull();
    });

    it('persists TalentDocument and TalentWorkHistoryEntry; source_document_id intra-lib UUID round-trips (§2.2 #8, #10)', async () => {
      await repo.createTalentDocument({
        id: DOC_ID,
        talent_id: TALENT,
        tenant_id: TENANT,
        uploaded_by_actor_id: ACTOR,
        uploaded_at: new Date('2026-05-19T11:00:00Z'),
        document_type: 'resume',
        filename: 'resume.pdf',
        file_storage_ref: 's3://aramo-docs/talent/aaa.../resume.pdf',
        mime_type: 'application/pdf',
        size_bytes: 524288,
        parse_status: 'parsed',
        consent_scope_at_upload: ['matching', 'contacting'],
        retention_policy: 'default',
        is_active: true,
      });

      const wh = await repo.createTalentWorkHistoryEntry({
        id: '00000000-0000-7000-8000-0000000000f1',
        talent_id: TALENT,
        tenant_id: TENANT,
        employer_name: 'Acme Corp',
        role_title: 'Senior Engineer',
        start_date: new Date('2020-01-15'),
        end_date: new Date('2024-12-31'),
        location: 'Remote (US)',
        employment_type: 'FTE',
        description_text: 'Led platform team',
        source: 'resume',
        source_document_id: DOC_ID,
        is_authoritative: true,
        created_at: new Date('2026-05-19T11:05:00Z'),
      });

      expect(wh.source_document_id).toBe(DOC_ID);

      const readDoc = await repo.findTalentDocumentById(DOC_ID);
      expect(readDoc?.uploaded_by_actor_id).toBe(ACTOR);
      expect(readDoc?.document_type).toBe('resume');
      expect(readDoc?.consent_scope_at_upload).toEqual(['matching', 'contacting']);
      expect(readDoc?.parse_status).toBe('parsed');
      expect(readDoc?.retention_policy).toBe('default');
      expect(readDoc?.size_bytes).toBe(524288);

      const readWh = await repo.findTalentWorkHistoryEntryById(wh.id);
      expect(readWh?.source_document_id).toBe(DOC_ID);
      expect(readWh?.source).toBe('resume');
    });

    it('persists TalentContactMethod with the §2.2 6-value type enum and 4-value verification enum (§2.2 #4)', async () => {
      const created = await repo.createTalentContactMethod({
        id: '00000000-0000-7000-8000-0000000000cc',
        talent_id: TALENT,
        tenant_id: TENANT,
        type: 'email',
        value: 'talent@example.com',
        is_primary: true,
        verification_status: 'verified',
        verified_at: new Date('2026-05-19T09:00:00Z'),
        created_at: new Date('2026-05-19T09:00:00Z'),
      });

      const read = await repo.findTalentContactMethodById(created.id);
      expect(read?.type).toBe('email');
      expect(read?.verification_status).toBe('verified');
      expect(read?.is_primary).toBe(true);
    });

    it('persists TalentRateExpectation employment_type "1099" — spec literal round-trips through @map translation (§2.2 #7)', async () => {
      // The §2.2 spec literal "1099" cannot be a Prisma enum identifier
      // (identifier rule forbids leading digits). The schema's
      // @map("1099") makes the DB value "1099" while the Prisma client
      // identifier is CONTRACT_1099. The repository accepts the spec
      // literal "1099" and translates internally; the returned row carries
      // the spec literal back.
      const created = await repo.createTalentRateExpectation({
        id: '00000000-0000-7000-8000-0000000000b1',
        talent_id: TALENT,
        tenant_id: TENANT,
        employment_type: '1099',
        min_rate: 85,
        target_rate: 110,
        currency: 'USD',
        period: 'HOURLY',
        source: 'talent_declared',
        updated_at: new Date('2026-05-19T09:30:00Z'),
      });

      expect(created.employment_type).toBe('1099');

      const read = await repo.findTalentRateExpectationById(created.id);
      expect(read?.employment_type).toBe('1099');
      expect(read?.min_rate).toBe(85);
      expect(read?.target_rate).toBe(110);
      expect(read?.period).toBe('HOURLY');
    });

    it('persists TalentRateExpectation across the other 3 employment_type values (W2 / C2C / FTE)', async () => {
      for (const [idx, et] of (['W2', 'C2C', 'FTE'] as const).entries()) {
        const id = `00000000-0000-7000-8000-0000000000b${idx + 2}`;
        const created = await repo.createTalentRateExpectation({
          id,
          talent_id: TALENT,
          tenant_id: TENANT,
          employment_type: et,
          min_rate: 100 + idx,
          currency: 'USD',
          period: 'ANNUAL',
          source: 'recruiter_entered',
          updated_at: new Date('2026-05-19T09:30:00Z'),
        });
        expect(created.employment_type).toBe(et);
        const read = await repo.findTalentRateExpectationById(id);
        expect(read?.employment_type).toBe(et);
      }
    });

    it('persists TalentWorkAuthorization with column shape; §14.4 treatment is deferred to F16 (§2.2 #6 — Sensitive)', async () => {
      const created = await repo.createTalentWorkAuthorization({
        id: '00000000-0000-7000-8000-0000000000aa',
        talent_id: TALENT,
        tenant_id: TENANT,
        work_authorization_status: 'US_CITIZEN',
        authorized_to_work_in: ['US'],
        visa_type: undefined,
        requires_sponsorship: false,
        updated_at: new Date('2026-05-19T09:00:00Z'),
      });

      const read = await repo.findTalentWorkAuthorizationById(created.id);
      expect(read?.work_authorization_status).toBe('US_CITIZEN');
      expect(read?.authorized_to_work_in).toEqual(['US']);
      expect(read?.visa_type).toBeNull();
      expect(read?.requires_sponsorship).toBe(false);
    });

    it('persists TalentDerivedSnapshot with the §2.2 Json fields opaque (§2.2 #17)', async () => {
      const skillConfidence = { typescript: 0.92, aws: 0.6 };
      const yearsBySkill = { typescript: 7.5, aws: 3 };
      const created = await repo.createTalentDerivedSnapshot({
        id: '00000000-0000-7000-8000-0000000000fa',
        talent_id: TALENT,
        tenant_id: TENANT,
        skill_confidence_scores: skillConfidence,
        estimated_years_experience_overall: 8.5,
        estimated_years_experience_by_skill: yearsBySkill,
        career_trajectory_pattern: 'steady_growth',
        availability_confidence: 0.8,
        trust_level: 'high',
        data_completeness_score: 0.95,
        computed_at: new Date('2026-05-19T12:00:00Z'),
      });

      const read = await repo.findTalentDerivedSnapshotById(created.id);
      expect(read?.skill_confidence_scores).toEqual(skillConfidence);
      expect(read?.estimated_years_experience_by_skill).toEqual(yearsBySkill);
      expect(read?.career_trajectory_pattern).toBe('steady_growth');
      expect(read?.availability_confidence).toBe(0.8);
      expect(read?.skill_domains).toBeNull();
    });

    it('allows TalentDocument.uploaded_by_actor_id to be a UUID that does not exist (no FK; Architecture §7.3)', async () => {
      // The migration emits zero FOREIGN KEY constraints — a forward-reference
      // UUID may point at a row that does not exist. The application layer
      // (and Architecture §9's weekly consistency-check job) is responsible
      // for referential integrity; the schema is not.
      const created = await repo.createTalentDocument({
        id: '00000000-0000-7000-8000-0000000000d9',
        talent_id: TALENT,
        tenant_id: TENANT,
        uploaded_by_actor_id: '00000000-0000-7000-8000-deadbeef0000',
        uploaded_at: new Date('2026-05-19T11:00:00Z'),
        document_type: 'other',
        filename: 'unknown.bin',
        file_storage_ref: 's3://aramo-docs/orphan/unknown.bin',
        mime_type: 'application/octet-stream',
        size_bytes: 1,
        parse_status: 'no_parse_attempted',
        consent_scope_at_upload: [],
        retention_policy: 'default',
        is_active: false,
      });

      expect(created.uploaded_by_actor_id).toBe('00000000-0000-7000-8000-deadbeef0000');
    });

    it('TalentEngagementEvent is NOT present on the Prisma client (deferred to M5 per directive §2 Ruling 1)', () => {
      // The 8th EvidenceReference target entity is named only in Group 2
      // (no inline shape in §2.2); its full shape lives in the engagement
      // domain (Plan v1.5 §M5). PR-5 builds the 7 fully-specified entities.
      // EvidenceReference with entity_type: "TalentEngagementEvent" remains
      // a structurally-valid closed-list value but is unresolvable until M5.
      const client = prisma as unknown as Record<string, unknown>;
      expect(client['talentEngagementEvent']).toBeUndefined();
    });
  },
);
