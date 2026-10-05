import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { hashSigningToken } from '../lib/signing-token.js';
import {
  EnvelopeAmbiguousError,
  ReminderNotAllowedError,
  SigningSessionExpiredError,
} from '../lib/domain/errors.js';

// COMM-RECRUITER-W1 (W1-C) — SAME-ENVELOPE reminder + reverse lookup on real
// Postgres 17. Proves: reminder preserves the SAME envelope + EnvelopeDocument
// (document_ref / document_revision_ref / source_sha256) and does NOT mint a new
// envelope; the prior signer session is REVOKED and a NEW one issued (new raw
// token / hash); a SIGNATURE_REMINDER_SENT ledger event is appended; and the
// token-security invariants hold. None of this existed at baseline 44cc7f90.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('COMM-RECRUITER-W1 — E-Sign same-envelope reminder (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function buildSentEnvelope(docRef: string, revRef: string, sha = 'AAA') {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Right to Represent', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: docRef, document_revision_ref: revRef, title: 'rtr.pdf', source_sha256: sha, ordinal: 1 });
    await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    return { envelopeId: env.id, s1: sessions[0]! };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('reverse-resolves the single non-terminal envelope; null when none; ambiguous when >1', async () => {
    const D = randomUUID();
    const R = randomUUID();
    expect(await service.findEnvelopeForDocument(TENANT, D, R)).toBeNull();
    const { envelopeId } = await buildSentEnvelope(D, R);
    const found = await service.findEnvelopeForDocument(TENANT, D, R);
    expect(found).toEqual({ envelope_id: envelopeId, status: 'SENT' });
    // A second non-terminal envelope for the SAME (doc, revision) → fail closed.
    await buildSentEnvelope(D, R);
    await expect(service.findEnvelopeForDocument(TENANT, D, R)).rejects.toBeInstanceOf(EnvelopeAmbiguousError);
  });

  it('SAME-ENVELOPE reminder: same envelope/doc/revision/hash, S1 revoked, new S2, SIGNATURE_REMINDER_SENT event', async () => {
    const D = randomUUID();
    const R = randomUUID();
    const { envelopeId, s1 } = await buildSentEnvelope(D, R, 'AAA');

    const envBefore = await db.query(`SELECT count(*)::int n FROM "esign"."SignatureEnvelope" WHERE tenant_id=$1`, [TENANT]);
    const docBefore = await db.query(`SELECT document_ref, document_revision_ref, source_sha256 FROM "esign"."EnvelopeDocument" WHERE envelope_id=$1`, [envelopeId]);

    const { sessions } = await service.remindSigner(TENANT, envelopeId, ACTOR);
    expect(sessions).toHaveLength(1);
    const s2 = sessions[0]!;

    // SAME envelope — no new envelope minted; EnvelopeDocument unchanged.
    const envAfter = await db.query(`SELECT count(*)::int n, max(status) status FROM "esign"."SignatureEnvelope" WHERE tenant_id=$1`, [TENANT]);
    expect(envAfter.rows[0].n).toBe(envBefore.rows[0].n);
    const after = await repo.getEnvelope(TENANT, envelopeId);
    expect(after.status).toBe('SENT'); // status unchanged (reminder is not a transition)
    const docAfter = await db.query(`SELECT document_ref, document_revision_ref, source_sha256 FROM "esign"."EnvelopeDocument" WHERE envelope_id=$1`, [envelopeId]);
    expect(docAfter.rows).toEqual(docBefore.rows);
    expect(docAfter.rows[0]).toMatchObject({ document_ref: D, document_revision_ref: R, source_sha256: 'AAA' });

    // S1 REVOKED, S2 ISSUED, different token hash.
    const s1row = await db.query(`SELECT status, revoked_at FROM "esign"."SigningSession" WHERE id=$1`, [s1.session_id]);
    expect(s1row.rows[0].status).toBe('REVOKED');
    expect(s1row.rows[0].revoked_at).not.toBeNull();
    const s2row = await db.query(`SELECT status, token_hash FROM "esign"."SigningSession" WHERE id=$1`, [s2.session_id]);
    expect(s2row.rows[0].status).toBe('ISSUED');
    expect(s2row.rows[0].token_hash).toBe(hashSigningToken(s2.raw_token));
    expect(s2.raw_token).not.toBe(s1.raw_token);
    expect(hashSigningToken(s2.raw_token)).not.toBe(hashSigningToken(s1.raw_token));

    // SIGNATURE_REMINDER_SENT ledger event appended (chained).
    const ev = await db.query(`SELECT count(*)::int n FROM "esign"."SignatureEvent" WHERE envelope_id=$1 AND event_type='SIGNATURE_REMINDER_SENT'`, [envelopeId]);
    expect(ev.rows[0].n).toBe(1);
  });

  it('token security: raw tokens never stored; revoked S1 cannot exchange; new S2 can', async () => {
    const { envelopeId, s1 } = await buildSentEnvelope(randomUUID(), randomUUID());
    // raw S1 is not a stored value.
    const leak1 = await db.query(`SELECT count(*)::int n FROM "esign"."SigningSession" WHERE token_hash=$1`, [s1.raw_token]);
    expect(leak1.rows[0].n).toBe(0);

    const { sessions } = await service.remindSigner(TENANT, envelopeId, ACTOR);
    const s2 = sessions[0]!;
    const leak2 = await db.query(`SELECT count(*)::int n FROM "esign"."SigningSession" WHERE token_hash=$1`, [s2.raw_token]);
    expect(leak2.rows[0].n).toBe(0);

    // The original capability can no longer be exchanged; the reissued one can.
    await expect(service.exchangeToken(s1.raw_token)).rejects.toBeInstanceOf(SigningSessionExpiredError);
    const ctx = await service.exchangeToken(s2.raw_token);
    expect(ctx.envelope_id).toBe(envelopeId);
  });

  it('reminder denied on a non-sent (DRAFT) envelope and on a terminal (VOIDED) envelope', async () => {
    const draft = await repo.createEnvelope({ tenant_id: TENANT, subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await repo.addSigner({ tenant_id: TENANT, envelope_id: draft.id, email: 'a@x.com', name: 'A', signing_order: 1 });
    await expect(service.remindSigner(TENANT, draft.id, ACTOR)).rejects.toBeInstanceOf(ReminderNotAllowedError);

    await service.voidEnvelope(TENANT, draft.id, ACTOR, 'done');
    await expect(service.remindSigner(TENANT, draft.id, ACTOR)).rejects.toBeInstanceOf(ReminderNotAllowedError);
  });

  it('excludes a terminal (VOIDED) envelope from the reverse lookup (historical envelopes may coexist)', async () => {
    const D = randomUUID();
    const R = randomUUID();
    const { envelopeId } = await buildSentEnvelope(D, R);
    await service.voidEnvelope(TENANT, envelopeId, ACTOR, 'superseded');
    // VOIDED is terminal → excluded; the document now has zero non-terminal envelopes.
    expect(await service.findEnvelopeForDocument(TENANT, D, R)).toBeNull();
  });
});
