import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { type ExecutionProducerPort } from '../lib/ports/execution-producer.port.js';
import {
  EnvelopeAlreadyExecutedError,
  EnvelopeIllegalTransitionError,
  SigningSessionExpiredError,
} from '../lib/domain/errors.js';

// ES-1 (Aramo-E-Sign-ES-1-Lifecycle-Integrity-Implementation-Authorization-v1_0
// §3) — envelope lifecycle integrity on real Postgres 17.
//
//   1. RED reproduction: a live signer capability could complete a VOIDED /
//      DECLINED / EXPIRED envelope, or re-complete a COMPLETED one.
//   2. Eligibility at every signer entry point (exchange, resolve, fill, complete).
//   3. One typed refusal for a terminal envelope: EnvelopeAlreadyExecutedError
//      (registered ENVELOPE_ALREADY_EXECUTED, 409).
//   4. Atomic, concurrency-safe transitions: racing operations leave exactly one
//      terminal outcome and at most one executed-artifact production.
//   5. Session revocation on void / decline / expire, in the same transaction.
//
// The execution producer is a counting fake: `produced` is the number of times
// executed artifacts would have been generated for an envelope.

const ROOT = resolve(__dirname, '../../../..');
const TERMINAL_EVENTS = ['ENVELOPE_COMPLETED', 'ENVELOPE_DECLINED', 'ENVELOPE_VOIDED', 'ENVELOPE_EXPIRED'];
const RACE_ROUNDS = 12;

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class CountingProducer implements ExecutionProducerPort {
  readonly calls = new Map<string, number>();
  async produce(_tenant_id: string, envelope_id: string) {
    this.calls.set(envelope_id, (this.calls.get(envelope_id) ?? 0) + 1);
    return [];
  }
  produced(envelope_id: string): number {
    return this.calls.get(envelope_id) ?? 0;
  }
}


const DISCLOSURE = currentDisclosure();
describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ES-1 envelope lifecycle integrity — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;
  let producer: CountingProducer;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  interface Sent {
    envelopeId: string;
    signers: { signerId: string; fieldId: string; token: string }[];
  }

  // A SENT envelope with `n` parallel signers, each owning one required SIGNATURE field.
  async function sendEnvelope(n: number): Promise<Sent> {
    const env = await repo.createEnvelope({
      tenant_id: TENANT, subject: 'Agreement', execution_mode: n > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE', created_by: ACTOR,
    });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'abc', ordinal: 1,
    });
    const fields: { signerId: string; fieldId: string }[] = [];
    for (let i = 1; i <= n; i++) {
      const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: `s${i}@x.com`, name: `Signer ${i}`, signing_order: i });
      const field = await repo.addField({
        tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100 + i * 40, required: true,
      });
      fields.push({ signerId: signer.id, fieldId: field.id });
    }
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    return {
      envelopeId: env.id,
      signers: fields.map((f) => ({ ...f, token: sessions.find((s) => s.signer_id === f.signerId)!.raw_token })),
    };
  }

  // Exchange + disclosure + fill: the signer is one call away from completing.
  async function readyToComplete(s: { fieldId: string; token: string }): Promise<SessionContext> {
    const ctx = await service.exchangeToken(s.token);
    await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    await service.fillField(ctx, s.fieldId, { value: 'Signed', signature_method: 'TYPED' });
    return ctx;
  }

  async function status(envelopeId: string): Promise<string> {
    return (await repo.getEnvelope(TENANT, envelopeId)).status;
  }

  // Pipeline & RTR Recon Remediation Directive v1.0 R2 (DEF-12) — the terminal events published
  // to consumers through the transactional outbox for this envelope.
  async function terminalOutboxTypes(envelopeId: string): Promise<string[]> {
    const r = await db.query(
      `SELECT event_type FROM "sign"."OutboxEvent" WHERE event_payload->>'envelope_id' = $1 AND event_type <> 'sign.envelope.executed.v1' ORDER BY created_at`,
      [envelopeId],
    );
    return r.rows.map((x: { event_type: string }) => x.event_type);
  }

  async function terminalEventCount(envelopeId: string): Promise<number> {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = ANY($2)`,
      [envelopeId, TERMINAL_EVENTS],
    );
    return r.rows[0].n;
  }

  async function eventCount(envelopeId: string): Promise<number> {
    const r = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [envelopeId]);
    return r.rows[0].n;
  }

  async function liveSessionCount(envelopeId: string): Promise<number> {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM "sign"."SigningSession" WHERE envelope_id = $1 AND status IN ('ISSUED','EXCHANGED','ACTIVE')`,
      [envelopeId],
    );
    return r.rows[0].n;
  }

  async function signerStatus(signerId: string): Promise<string> {
    const r = await db.query(`SELECT status FROM "sign"."Signer" WHERE id = $1`, [signerId]);
    return r.rows[0].status;
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
  }, 120_000);

  beforeEach(() => {
    producer = new CountingProducer();
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner(), producer);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // ── R2 (DEF-12) — a declined / voided / expired envelope is PUBLISHED, once, in-transaction ──
  describe('terminal envelopes publish their outcome to consumers (Remediation v1.0 R2, DEF-12)', () => {
    it('DECLINED → exactly one sign.envelope.declined.v1 outbox event', async () => {
      const e = await sendEnvelope(1);
      const ctx = await service.exchangeToken(e.signers[0]!.token);
      await service.decline(TENANT, e.envelopeId, ctx.signer_id, 'no');
      expect(await terminalOutboxTypes(e.envelopeId)).toEqual(['sign.envelope.declined.v1']);
    });

    it('VOIDED → exactly one sign.envelope.voided.v1 outbox event', async () => {
      const e = await sendEnvelope(1);
      await service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'withdrawn');
      expect(await terminalOutboxTypes(e.envelopeId)).toEqual(['sign.envelope.voided.v1']);
    });

    it('EXPIRED → exactly one sign.envelope.expired.v1 outbox event', async () => {
      const e = await sendEnvelope(1);
      await service.expireEnvelope(TENANT, e.envelopeId);
      expect(await terminalOutboxTypes(e.envelopeId)).toEqual(['sign.envelope.expired.v1']);
    });

    it('a refused terminal transition publishes nothing (the event commits only with the state change)', async () => {
      const e = await sendEnvelope(1);
      await service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'withdrawn');
      await expect(service.expireEnvelope(TENANT, e.envelopeId)).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
      expect(await terminalOutboxTypes(e.envelopeId)).toEqual(['sign.envelope.voided.v1']);
    });

    it('void ∥ decline publishes exactly one terminal event (the winner)', async () => {
      const e = await sendEnvelope(1);
      const ctx = await service.exchangeToken(e.signers[0]!.token);
      const [v] = await Promise.allSettled([
        service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'race'),
        service.decline(TENANT, e.envelopeId, ctx.signer_id, 'race'),
      ]);
      expect(await terminalOutboxTypes(e.envelopeId)).toEqual([
        v.status === 'fulfilled' ? 'sign.envelope.voided.v1' : 'sign.envelope.declined.v1',
      ]);
    });
  });

  // ── 1. Defect reproduction (RED on the pre-ES-1 code) ──────────────────────
  describe('a live signer capability cannot complete a terminal envelope', () => {
    it('VOIDED: completion is refused, the envelope stays VOIDED, nothing is executed', async () => {
      const e = await sendEnvelope(1);
      const ctx = await readyToComplete(e.signers[0]!);
      await service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'withdrawn');

      await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      expect(await status(e.envelopeId)).toBe('VOIDED');
      expect(producer.produced(e.envelopeId)).toBe(0);
      expect(await signerStatus(e.signers[0]!.signerId)).not.toBe('SIGNED');
    });

    it('DECLINED: the declining signer cannot then complete with the same capability', async () => {
      const e = await sendEnvelope(1);
      const ctx = await readyToComplete(e.signers[0]!);
      await service.decline(TENANT, e.envelopeId, ctx.signer_id, 'terms not agreed');

      await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      expect(await status(e.envelopeId)).toBe('DECLINED');
      expect(producer.produced(e.envelopeId)).toBe(0);
      expect(await signerStatus(ctx.signer_id)).toBe('DECLINED');
    });

    it('DECLINED: a co-signer cannot complete after another signer declined', async () => {
      const e = await sendEnvelope(2);
      const ctxB = await readyToComplete(e.signers[1]!);
      const ctxA = await service.exchangeToken(e.signers[0]!.token);
      await service.decline(TENANT, e.envelopeId, ctxA.signer_id, 'not authorised');

      await expect(service.completeSigner(ctxB)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      expect(await status(e.envelopeId)).toBe('DECLINED');
      expect(await signerStatus(ctxB.signer_id)).not.toBe('SIGNED');
    });

    it('EXPIRED: an envelope already in EXPIRED is enforced as terminal', async () => {
      const e = await sendEnvelope(1);
      const ctx = await readyToComplete(e.signers[0]!);
      await service.expireEnvelope(TENANT, e.envelopeId);

      await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      expect(await status(e.envelopeId)).toBe('EXPIRED');
      expect(producer.produced(e.envelopeId)).toBe(0);
    });

    it('COMPLETED: a second completion is refused and executes nothing twice', async () => {
      const e = await sendEnvelope(1);
      const ctx = await readyToComplete(e.signers[0]!);
      expect((await service.completeSigner(ctx)).envelope_status).toBe('COMPLETED');

      await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      expect(await terminalEventCount(e.envelopeId)).toBe(1);
      expect(producer.produced(e.envelopeId)).toBe(1);
    });
  });

  // ── 2. Eligibility at every signer entry point ─────────────────────────────
  describe.each([
    ['VOIDED', async (s: EsignService, envelopeId: string) => s.voidEnvelope(TENANT, envelopeId, ACTOR, 'withdrawn')],
    ['DECLINED', async (s: EsignService, envelopeId: string, signerId: string) => s.decline(TENANT, envelopeId, signerId, 'no')],
    ['EXPIRED', async (s: EsignService, envelopeId: string) => s.expireEnvelope(TENANT, envelopeId)],
  ] as const)('on a %s envelope', (terminal, makeTerminal) => {
    it('exchange, resolve, disclosure and fill are refused and append nothing', async () => {
      const e = await sendEnvelope(2);
      const live = e.signers[0]!;
      const ctx = await service.exchangeToken(live.token);
      await makeTerminal(service, e.envelopeId, e.signers[1]!.signerId);
      expect(await status(e.envelopeId)).toBe(terminal);
      const before = await eventCount(e.envelopeId);

      await expect(service.exchangeToken(e.signers[1]!.token)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      await expect(service.resolveSession(live.token)).rejects.toBeInstanceOf(EnvelopeAlreadyExecutedError);
      await expect(service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 })).rejects.toBeInstanceOf(
        EnvelopeAlreadyExecutedError,
      );
      await expect(service.fillField(ctx, live.fieldId, { value: 'late', signature_method: 'TYPED' })).rejects.toBeInstanceOf(
        EnvelopeAlreadyExecutedError,
      );
      await expect(service.decline(TENANT, e.envelopeId, ctx.signer_id, 'late')).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);

      expect(await eventCount(e.envelopeId)).toBe(before);
      expect(await status(e.envelopeId)).toBe(terminal);
      const field = await db.query(`SELECT value FROM "sign"."SignatureField" WHERE id = $1`, [live.fieldId]);
      expect(field.rows[0].value).toBeNull();
    });

    it('revokes every live signing session in the same transaction', async () => {
      const e = await sendEnvelope(2);
      await service.exchangeToken(e.signers[0]!.token); // ACTIVE
      expect(await liveSessionCount(e.envelopeId)).toBe(2);
      await makeTerminal(service, e.envelopeId, e.signers[1]!.signerId);

      expect(await liveSessionCount(e.envelopeId)).toBe(0);
      const revoked = await db.query(
        `SELECT count(*)::int AS n FROM "sign"."SigningSession" WHERE envelope_id = $1 AND status = 'REVOKED' AND revoked_at IS NOT NULL`,
        [e.envelopeId],
      );
      expect(revoked.rows[0].n).toBe(2);
    });
  });

  it('a signer who has completed cannot alter a field while co-signers are pending', async () => {
    const e = await sendEnvelope(2);
    const ctx = await readyToComplete(e.signers[0]!);
    expect((await service.completeSigner(ctx)).envelope_status).toBe('IN_PROGRESS');

    await expect(service.fillField(ctx, e.signers[0]!.fieldId, { value: 'changed', signature_method: 'TYPED' })).rejects.toBeInstanceOf(
      SigningSessionExpiredError,
    );
    await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(SigningSessionExpiredError);
    const field = await db.query(`SELECT value FROM "sign"."SignatureField" WHERE id = $1`, [e.signers[0]!.fieldId]);
    expect(field.rows[0].value).toBe('Signed');
  });

  it('parallel signing is unchanged: either order completes the envelope exactly once', async () => {
    const e = await sendEnvelope(2);
    const ctxB = await readyToComplete(e.signers[1]!);
    const ctxA = await readyToComplete(e.signers[0]!);
    expect((await service.completeSigner(ctxB)).envelope_status).toBe('IN_PROGRESS');
    expect((await service.completeSigner(ctxA)).envelope_status).toBe('COMPLETED');
    expect(await terminalEventCount(e.envelopeId)).toBe(1);
    expect(producer.produced(e.envelopeId)).toBe(1);
  });

  it('terminal transitions are irreversible through the service API', async () => {
    const e = await sendEnvelope(1);
    await service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'withdrawn');
    await expect(service.expireEnvelope(TENANT, e.envelopeId)).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'again')).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(service.send(TENANT, e.envelopeId, ACTOR)).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    expect(await status(e.envelopeId)).toBe('VOIDED');
    expect(await terminalEventCount(e.envelopeId)).toBe(1);
  });

  // ── 4. Concurrency: racing operations, real connection pool ────────────────
  describe('concurrent operations leave exactly one consistent outcome', () => {
    it(`void ∥ complete (${RACE_ROUNDS} rounds)`, async () => {
      const outcomes = { VOIDED: 0, COMPLETED: 0 };
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const e = await sendEnvelope(1);
        const ctx = await readyToComplete(e.signers[0]!);
        const [v, c] = await Promise.allSettled([
          service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'race'),
          service.completeSigner(ctx),
        ]);
        const final = await status(e.envelopeId);
        expect([v.status, c.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
        expect(final).toBe(v.status === 'fulfilled' ? 'VOIDED' : 'COMPLETED');
        expect(await terminalEventCount(e.envelopeId)).toBe(1);
        expect(producer.produced(e.envelopeId)).toBe(final === 'COMPLETED' ? 1 : 0);
        expect(await liveSessionCount(e.envelopeId)).toBe(0);
        if (final === 'VOIDED') expect(await signerStatus(ctx.signer_id)).not.toBe('SIGNED');
        outcomes[final as 'VOIDED' | 'COMPLETED'] += 1;
      }
      expect(outcomes.VOIDED + outcomes.COMPLETED).toBe(RACE_ROUNDS);
      console.info(`ES-1 race void ∥ complete: ${JSON.stringify(outcomes)}`);
    });

    it(`void ∥ decline (${RACE_ROUNDS} rounds)`, async () => {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const e = await sendEnvelope(1);
        const ctx = await service.exchangeToken(e.signers[0]!.token);
        const [v, d] = await Promise.allSettled([
          service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'race'),
          service.decline(TENANT, e.envelopeId, ctx.signer_id, 'race'),
        ]);
        expect([v.status, d.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
        expect(await status(e.envelopeId)).toBe(v.status === 'fulfilled' ? 'VOIDED' : 'DECLINED');
        expect(await terminalEventCount(e.envelopeId)).toBe(1);
        expect(await liveSessionCount(e.envelopeId)).toBe(0);
      }
    });

    it(`two last signers complete at once (${RACE_ROUNDS} rounds)`, async () => {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const e = await sendEnvelope(2);
        const ctxA = await readyToComplete(e.signers[0]!);
        const ctxB = await readyToComplete(e.signers[1]!);
        const results = await Promise.allSettled([service.completeSigner(ctxA), service.completeSigner(ctxB)]);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(await status(e.envelopeId)).toBe('COMPLETED');
        expect(await terminalEventCount(e.envelopeId)).toBe(1);
        expect(producer.produced(e.envelopeId)).toBe(1);
      }
    });

    it(`the same signer completes twice at once (${RACE_ROUNDS} rounds)`, async () => {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const e = await sendEnvelope(1);
        const ctx = await readyToComplete(e.signers[0]!);
        const results = await Promise.allSettled([service.completeSigner(ctx), service.completeSigner(ctx)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await status(e.envelopeId)).toBe('COMPLETED');
        expect(await terminalEventCount(e.envelopeId)).toBe(1);
        expect(producer.produced(e.envelopeId)).toBe(1);
      }
    });

    it(`exchange ∥ void never resurrects a voided envelope (${RACE_ROUNDS} rounds)`, async () => {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const e = await sendEnvelope(1);
        const [, v] = await Promise.allSettled([
          service.exchangeToken(e.signers[0]!.token),
          service.voidEnvelope(TENANT, e.envelopeId, ACTOR, 'race'),
        ]);
        expect(v.status).toBe('fulfilled');
        expect(await status(e.envelopeId)).toBe('VOIDED');
        expect(await liveSessionCount(e.envelopeId)).toBe(0);
      }
    });
  });
});
