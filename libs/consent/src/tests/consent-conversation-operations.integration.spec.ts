import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ContactChannel } from '@aramo/common';

import {
  ConsentRepository,
  type RecordConsentEventInput,
  type ResolveConsentStateInput,
} from '../lib/consent.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import type { ConsentCheckOperation } from '../lib/dto/consent-check-operation.js';
import type { ConsentScopeValue } from '../lib/dto/consent-grant-request.dto.js';
import {
  OPERATION_NOTICE_CURRENT_VERSION,
  renderOperationNotice,
  hashOperationNotice,
} from '../lib/operation-notice-texts.js';

// CI-B1 (Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §4) — real-PG
// proof that recording / transcription / ai_processing are DISTINCT, independently
// evaluated governed operations, that each fails closed, that no operation's
// permission implies another's (esp. "RECORDING IS NOT A PREREQUISITE FOR
// TRANSCRIPTION"), that tenant isolation holds, that notice/affirmative evidence
// persists reproducibly, and that existing contacting/communication behavior is
// unchanged. No schema migration is introduced (scope/operation are TEXT values);
// this exercises the live decision engine + ledger persistence against Postgres.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
const REKEY_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const RECRUITER_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
// Recent so the contacting 12-month staleness window is not tripped.
const RECENT = '2026-09-01T00:00:00Z';

// Split DDL respecting $$-quoted trigger bodies (mirrors consent.integration.spec.ts).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CI-B1 conversation-operation consent — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ConsentRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const p of [MIGRATION_PATH, REKEY_MIGRATION_PATH]) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          if (stmt.trim().length === 0) continue;
          await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConsentRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // ---- helpers ----------------------------------------------------------
    async function record(
      scope: ConsentScopeValue,
      opts: {
        tenant?: string;
        talent: string;
        action?: 'granted' | 'revoked';
        occurred_at?: string;
        consent_version?: string;
        consent_text_snapshot?: string;
      },
    ) {
      const input: RecordConsentEventInput = {
        tenant_id: opts.tenant ?? TENANT_A,
        talent_record_id: opts.talent,
        action: opts.action ?? 'granted',
        scope,
        captured_method: 'recruiter_capture',
        captured_by_actor_id: RECRUITER_ID,
        consent_version: opts.consent_version ?? 'v1',
        occurred_at: opts.occurred_at ?? RECENT,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        requestId: `rec-${randomUUID()}`,
        ...(opts.consent_text_snapshot
          ? { consent_text_snapshot: opts.consent_text_snapshot }
          : {}),
      };
      return repo.recordConsentEvent(input);
    }

    // Grant the full contacting dependency chain (profile_storage → matching →
    // contacting) so communication/contacting can resolve allowed.
    async function grantContactingChain(talent: string, tenant = TENANT_A) {
      for (const s of ['profile_storage', 'matching', 'contacting'] as const) {
        await record(s, { talent, tenant });
      }
    }

    async function check(
      operation: ConsentCheckOperation,
      opts: { tenant?: string; talent: string; channel?: ContactChannel },
    ) {
      const input: ResolveConsentStateInput = {
        tenant_id: opts.tenant ?? TENANT_A,
        talent_record_id: opts.talent,
        operation,
        ...(opts.channel ? { channel: opts.channel } : {}),
        requestHash: randomUUID(),
        requestId: `chk-${randomUUID()}`,
      };
      return repo.resolveConsentState(input);
    }

    const allowed = (r: { result: string }) => r.result === 'allowed';

    // =====================================================================
    // CRITICAL POLICY CASES (directive §CI-B1)
    // =====================================================================

    it('CASE 1 — contacting=ALLOW, recording=PROHIBITED, transcription=ALLOW, AI=ALLOW is an ACCEPTED combination (recording denial does not block transcription)', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      await record('recording', { talent }); // grant then...
      await record('recording', { talent, action: 'revoked' }); // ...revoke → prohibited
      await record('transcription', { talent });
      await record('ai_processing', { talent });

      const contacting = await check('communication', { talent, channel: 'phone' });
      const recording = await check('recording', { talent });
      const transcription = await check('transcription', { talent });
      const ai = await check('ai_processing', { talent });

      expect(allowed(contacting)).toBe(true);
      expect(allowed(recording)).toBe(false); // prohibited
      expect(allowed(transcription)).toBe(true); // NOT blocked by recording denial
      expect(allowed(ai)).toBe(true);
      // ACCEPTED COMBINATION = YES
    });

    it('CASE 2 — transcription=DENY blocks transcript authorization even when AI is allowed (fail-closed)', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      await record('transcription', { talent }); // grant then revoke → denied
      await record('transcription', { talent, action: 'revoked' });
      await record('ai_processing', { talent });

      const transcription = await check('transcription', { talent });
      expect(allowed(transcription)).toBe(false); // TRANSCRIPT AUTHORIZED = NO
    });

    it('CASE 3 — recording=PROHIBITED, transcription=ALLOW, AI=DENY: contact + transcription proceed, AI processing denied', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      await record('recording', { talent, action: 'revoked' }); // prohibited
      await record('transcription', { talent }); // allowed
      await record('ai_processing', { talent }); // grant then revoke → denied
      await record('ai_processing', { talent, action: 'revoked' });

      expect(allowed(await check('communication', { talent, channel: 'phone' }))).toBe(true);
      expect(allowed(await check('transcription', { talent }))).toBe(true);
      expect(allowed(await check('ai_processing', { talent }))).toBe(false); // AI AUTHORIZED = NO
    });

    it('CASE 4 — contacting=DENY is not widened by later recording/transcription/AI permissions', async () => {
      const talent = randomUUID();
      // Contacting explicitly revoked (dependency chain granted first so this is a
      // clean scope DENIAL, not a dependency-unmet error).
      await grantContactingChain(talent);
      await record('contacting', { talent, action: 'revoked' });
      // Later conversation-operation permissions must NOT widen contacting.
      await record('recording', { talent });
      await record('transcription', { talent });
      await record('ai_processing', { talent });

      const contacting = await check('communication', { talent, channel: 'phone' });
      expect(allowed(contacting)).toBe(false); // contacting stays denied
      // sanity: the conversation ops themselves are independently allowed
      expect(allowed(await check('transcription', { talent }))).toBe(true);
    });

    it('CASE 5 — transcription with no affirmative grant fails closed (missing evidence ≠ implied consent)', async () => {
      const talent = randomUUID();
      await record('recording', { talent }); // ledger non-empty, but NO transcription grant
      const transcription = await check('transcription', { talent });
      expect(allowed(transcription)).toBe(false);
    });

    it('CASE 6 — revoked transcription authorization is denied and does not silently reactivate', async () => {
      const talent = randomUUID();
      await record('transcription', { talent }); // granted
      await record('transcription', { talent, action: 'revoked' }); // revoked
      expect(allowed(await check('transcription', { talent }))).toBe(false);
      // a second check does not silently reactivate
      expect(allowed(await check('transcription', { talent }))).toBe(false);
    });

    it('CASE 7 — wrong tenant cannot read another tenant’s transcription grant (conceal/deny)', async () => {
      const talent = randomUUID();
      await record('transcription', { talent, tenant: TENANT_A });
      const asA = await check('transcription', { talent, tenant: TENANT_A });
      const asB = await check('transcription', { talent, tenant: TENANT_B });
      expect(allowed(asA)).toBe(true);
      expect(allowed(asB)).toBe(false); // tenant isolation — not visible to B
    });

    // =====================================================================
    // NO-WIDENING INVARIANTS (directive §CI-B1)
    // =====================================================================

    it('no-widening — recording permission does NOT grant transcription', async () => {
      const talent = randomUUID();
      await record('recording', { talent });
      expect(allowed(await check('recording', { talent }))).toBe(true);
      expect(allowed(await check('transcription', { talent }))).toBe(false);
    });

    it('no-widening — transcription permission does NOT grant AI processing', async () => {
      const talent = randomUUID();
      await record('transcription', { talent });
      expect(allowed(await check('transcription', { talent }))).toBe(true);
      expect(allowed(await check('ai_processing', { talent }))).toBe(false);
    });

    it('no-widening — AI-processing permission does NOT grant transcription', async () => {
      const talent = randomUUID();
      await record('ai_processing', { talent });
      expect(allowed(await check('ai_processing', { talent }))).toBe(true);
      expect(allowed(await check('transcription', { talent }))).toBe(false);
    });

    it('no-widening — contacting permission does NOT grant transcription', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      expect(allowed(await check('communication', { talent, channel: 'phone' }))).toBe(true);
      expect(allowed(await check('transcription', { talent }))).toBe(false);
    });

    // =====================================================================
    // NOTICE / AFFIRMATIVE EVIDENCE (directive §4.4)
    // =====================================================================

    it('notice/evidence — a transcription grant persists a reproducible {notice version, exact snapshot} and then resolves allowed', async () => {
      const talent = randomUUID();
      const version = OPERATION_NOTICE_CURRENT_VERSION.transcription;
      const snapshot = renderOperationNotice(version, { recipient_tenant_id: TENANT_A });
      await record('transcription', {
        talent,
        consent_version: version,
        consent_text_snapshot: snapshot,
      });

      const row = await prisma.talentConsentEvent.findFirst({
        where: { tenant_id: TENANT_A, talent_record_id: talent, scope: 'transcription' },
      });
      expect(row?.consent_version).toBe(version);
      expect(row?.consent_text_snapshot).toBe(snapshot);
      // The persisted snapshot hashes to the same forensic anchor.
      const evidence = hashOperationNotice(version, { recipient_tenant_id: TENANT_A });
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(row!.consent_text_snapshot!, 'utf8').digest('hex')).toBe(
        evidence.hash,
      );

      expect(allowed(await check('transcription', { talent }))).toBe(true);
    });

    // =====================================================================
    // AUDIT / DECISION PROVENANCE
    // =====================================================================

    it('audit — a conversation-operation decision writes a consent.check.decision audit row', async () => {
      const talent = randomUUID();
      await record('ai_processing', { talent });
      await check('ai_processing', { talent });
      const audits = await prisma.consentAuditEvent.findMany({
        where: {
          tenant_id: TENANT_A,
          // audit-domain vocab: subject_id holds the TalentRecord.id (Step-5 rekey)
          subject_id: talent,
          event_type: 'consent.check.decision',
        },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    // =====================================================================
    // NO REGRESSION — existing communication/contacting behavior intact
    // =====================================================================

    it('regression — existing communication(phone) gate still resolves allowed on a granted contacting chain', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      expect(allowed(await check('communication', { talent, channel: 'phone' }))).toBe(true);
      expect(allowed(await check('communication', { talent, channel: 'email' }))).toBe(true);
    });

    it('regression — revoked contacting still denies communication (unchanged)', async () => {
      const talent = randomUUID();
      await grantContactingChain(talent);
      await record('contacting', { talent, action: 'revoked' });
      expect(allowed(await check('communication', { talent, channel: 'phone' }))).toBe(false);
    });
  },
);
