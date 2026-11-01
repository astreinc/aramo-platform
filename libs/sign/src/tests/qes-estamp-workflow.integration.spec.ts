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
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SignatureFieldIncompleteError } from '../lib/domain/errors.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { type ExecutionProducerPort } from '../lib/ports/execution-producer.port.js';
import { QesProviderError, type QesSigningPort } from '../lib/ports/qes-signing.port.js';
import { type EstampPort } from '../lib/ports/estamp.port.js';
import { QesWorkflowService } from '../lib/regulated/qes-workflow.service.js';
import { EstampWorkflowService } from '../lib/regulated/estamp-workflow.service.js';
import { RegulatedSigningStateError } from '../lib/regulated/regulated-errors.js';
import { RSA_SHA256_SIGNATURE_OID } from '../lib/regulated/qes-evidence.js';

import { makeTestCertificate, signDigest } from './support/test-certificate.js';

// Feature-Parity §1.16 / §1.19 (Amendment A1) — the QES and e-stamp workflows end to end on
// real Postgres 17, with STUB vendor ports (no QTSP or aggregator is ever called): the QES
// two-phase flow to SIGNED, the completion guard, a QTSP refusal, and the e-stamp order →
// certificate → attached-first flow with its send guard.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();
const REDIRECT = 'https://sign.test/qes/callback';

function signMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

class NoopProducer implements ExecutionProducerPort {
  async produce() {
    return [];
  }
}

// A stub QTSP: signs the authorized hash with a throwaway test key.
class StubQtsp implements QesSigningPort {
  readonly provider = 'stub';
  readonly configured = true;
  readonly cert = makeTestCertificate('Asha Rao');
  refuseSign = false;
  lastHash: string | null = null;
  async beginIdentity(i: { state: string }) {
    return { redirect_url: `https://qtsp.test/authorize?scope=service&state=${encodeURIComponent(i.state)}` };
  }
  async completeIdentity() {
    return { credential_id: 'cred-1', certificate_chain_pem: [this.cert.pem], signature_algorithm_oids: [RSA_SHA256_SIGNATURE_OID], authorization_level: 'SCAL2' };
  }
  async beginSignature(i: { state: string; hash_b64: string }) {
    this.lastHash = i.hash_b64;
    return { redirect_url: `https://qtsp.test/authorize?scope=credential&state=${encodeURIComponent(i.state)}` };
  }
  async signHash(i: { hash_b64: string }) {
    if (this.refuseSign) throw new QesProviderError('qtsp_http_403');
    return { signature_b64: signDigest(this.cert.privateKey, i.hash_b64), qtsp_reference: 'resp-1' };
  }
}

class StubAggregator implements EstampPort {
  readonly provider = 'stub';
  readonly configured = true;
  issued = false;
  constructor(private readonly pdf: Uint8Array) {}
  async order() {
    return { provider_order_ref: 'agg-1', status: 'PENDING' as const };
  }
  async certificate() {
    if (!this.issued) return { status: 'PENDING' as const };
    return { status: 'ISSUED' as const, certificate_number: 'IN-KA12345678901234X', issued_at: new Date('2026-11-01T00:00:00Z'), pdf: this.pdf };
  }
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Feature-Parity A1 — QES and e-stamp workflows, real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let engine: EsignService;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function draft(): Promise<{ envelopeId: string; signerId: string; fieldId: string; docId: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Deed', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'deed.pdf', source_sha256: 'ab'.repeat(32), ordinal: 0 });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: `q-${env.id.slice(0, 8)}@x.com`, name: 'Asha Rao', signing_order: 1 });
    const field = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, required: true });
    return { envelopeId: env.id, signerId: signer.id, fieldId: field.id, docId: doc.id };
  }
  async function events(envelopeId: string): Promise<string[]> {
    return (await db.query(`SELECT event_type FROM "sign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at, id`, [envelopeId])).rows.map((r) => r.event_type as string);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of signMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    engine = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner(), new NoopProducer());
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('QES: required on the draft, proofed and signed at the QTSP, then the signer completes', async () => {
    const qtsp = new StubQtsp();
    const qes = new QesWorkflowService(prisma, repo, qtsp);
    const d = await draft();
    const set = await qes.setSignatureLevel({ tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId, level: 'QES', actor_ref: ACTOR });
    expect(set.map((x) => x.state)).toEqual(['REQUIRED']);
    await qes.assertSendable(TENANT, d.envelopeId);
    const { sessions } = await engine.send(TENANT, d.envelopeId, ACTOR);
    const ctx = await engine.exchangeToken(sessions[0]!.raw_token);
    await engine.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    await engine.fillField(ctx, d.fieldId, { value: 'Asha Rao', signature_method: 'TYPED' });

    // Not yet signed at the QTSP: completion is refused.
    const early = await engine.completeSigner(ctx).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(SignatureFieldIncompleteError);
    expect((early as SignatureFieldIncompleteError).reason).toBe('qes_signature_pending');

    const ref = { tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId };
    const begun = await qes.beginIdentity(ref, REDIRECT);
    expect(begun.state).toBe('IDENTITY_PROOFING_PENDING');
    // A forged state is refused.
    await expect(qes.complete(ref, { state: 'forged', code: 'c', redirect_uri: REDIRECT })).rejects.toBeInstanceOf(RegulatedSigningStateError);
    const authorized = await qes.complete(ref, { state: stateOf(begun.redirect_url!), code: 'c1', redirect_uri: REDIRECT });
    expect(authorized.state).toBe('AUTHORIZED');
    const signed = await qes.complete(ref, { state: stateOf(authorized.redirect_url!), code: 'c2', redirect_uri: REDIRECT });
    expect(signed).toEqual({ state: 'SIGNED', redirect_url: null });

    const view = await qes.forSigner(ref);
    expect(view?.state).toBe('SIGNED');
    expect(view?.certificate?.subject).toContain('Asha Rao');
    expect(view?.signature_sha256).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.signQesSignature.findFirstOrThrow({ where: { signer_id: d.signerId } });
    expect(row.signed_digest_b64).toBe(qtsp.lastHash);
    expect(row.pending_state_sha256).toBeNull();

    const done = await engine.completeSigner(ctx);
    expect(done.envelope_status).toBe('COMPLETED');
    const evs = await events(d.envelopeId);
    for (const t of ['QES_LEVEL_SET', 'QES_IDENTITY_PROOFING_STARTED', 'QES_AUTHORIZED', 'QES_SIGNATURE_AUTHORIZATION_STARTED', 'QES_SIGNED']) expect(evs).toContain(t);
    const signedEvent = await db.query(`SELECT payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'QES_SIGNED'`, [d.envelopeId]);
    expect(signedEvent.rows[0].payload).toMatchObject({ signature_level: 'QES', signature_verified: true, provider: 'stub' });
  });

  it('QES: a QTSP refusal fails the row, and the signer can start again', async () => {
    const qtsp = new StubQtsp();
    qtsp.refuseSign = true;
    const qes = new QesWorkflowService(prisma, repo, qtsp);
    const d = await draft();
    await qes.setSignatureLevel({ tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId, level: 'QES', actor_ref: ACTOR });
    await engine.send(TENANT, d.envelopeId, ACTOR);
    const ref = { tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId };
    const begun = await qes.beginIdentity(ref, REDIRECT);
    const authorized = await qes.complete(ref, { state: stateOf(begun.redirect_url!), code: 'c1', redirect_uri: REDIRECT });
    await expect(qes.complete(ref, { state: stateOf(authorized.redirect_url!), code: 'c2', redirect_uri: REDIRECT })).rejects.toBeInstanceOf(QesProviderError);
    expect((await qes.forSigner(ref))?.state).toBe('FAILED');
    expect((await qes.forSigner(ref))?.failure_reason).toBe('qtsp_http_403');
    expect((await qes.beginIdentity(ref, REDIRECT)).state).toBe('IDENTITY_PROOFING_PENDING');
    expect(await events(d.envelopeId)).toContain('QES_FAILED');
  });

  it('QES: the level is DRAFT-only, and STANDARD removes the requirement', async () => {
    const qes = new QesWorkflowService(prisma, repo, new StubQtsp());
    const d = await draft();
    await qes.setSignatureLevel({ tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId, level: 'QES', actor_ref: ACTOR });
    expect(await qes.setSignatureLevel({ tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId, level: 'STANDARD', actor_ref: ACTOR })).toEqual([]);
    await engine.send(TENANT, d.envelopeId, ACTOR);
    await expect(qes.setSignatureLevel({ tenant_id: TENANT, envelope_id: d.envelopeId, signer_id: d.signerId, level: 'QES', actor_ref: ACTOR })).rejects.toThrow();
  });

  it('e-stamp: order, wait, issue, attach first; the send guard follows the order', async () => {
    const agg = new StubAggregator(new Uint8Array([1]));
    const estamp = new EstampWorkflowService(prisma, repo, agg);
    const d = await draft();
    const order = { state_code: 'IN-KA', article_code: 'Article 5(J)', stamp_duty_amount_paise: 20000, consideration_amount_paise: null, first_party: 'Acme', second_party: 'Ravi', purchaser: 'Acme', description: null };
    const ordered = await estamp.request({ tenant_id: TENANT, envelope_id: d.envelopeId, actor_ref: ACTOR, order });
    expect([ordered.state, ordered.provider_order_ref, ordered.stamp_duty_amount_paise, ordered.currency]).toEqual(['ORDERED', 'agg-1', 20000, 'INR']);
    await expect(estamp.request({ tenant_id: TENANT, envelope_id: d.envelopeId, actor_ref: ACTOR, order })).rejects.toBeInstanceOf(RegulatedSigningStateError);
    await expect(estamp.assertSendable(TENANT, d.envelopeId)).rejects.toBeInstanceOf(RegulatedSigningStateError);

    expect((await estamp.poll({ tenant_id: TENANT, envelope_id: d.envelopeId, actor_ref: ACTOR })).kind).toBe('unchanged');
    agg.issued = true;
    const polled = await estamp.poll({ tenant_id: TENANT, envelope_id: d.envelopeId, actor_ref: ACTOR });
    expect(polled.kind).toBe('issued');
    if (polled.kind !== 'issued') throw new Error('unreachable');
    const attached = await estamp.attach({
      tenant_id: TENANT,
      envelope_id: d.envelopeId,
      actor_ref: ACTOR,
      order_id: polled.order_id,
      certificate: { certificate_number: polled.certificate_number, issued_at: polled.issued_at, source_object_key: 'esign/source/cert', source_sha256: 'cd'.repeat(32), byte_size: 1, pages: [{ width: 595, height: 842 }] },
    });
    expect(attached.state).toBe('ATTACHED');
    const docs = await prisma.envelopeDocument.findMany({ where: { envelope_id: d.envelopeId }, orderBy: { ordinal: 'asc' } });
    expect(docs.map((x) => [x.id === attached.attached_document_id, x.ordinal])).toEqual([[true, 0], [false, 1]]);
    await expect(estamp.assertSendable(TENANT, d.envelopeId)).resolves.toBeUndefined();

    // Moving the certificate out of first place blocks the send again.
    await prisma.envelopeDocument.update({ where: { id: attached.attached_document_id! }, data: { ordinal: 5 } });
    await expect(estamp.assertSendable(TENANT, d.envelopeId)).rejects.toThrow(/estamp_not_first/);
    const evs = await events(d.envelopeId);
    for (const t of ['ESTAMP_REQUESTED', 'ESTAMP_ORDERED', 'ESTAMP_ISSUED', 'ESTAMP_ATTACHED']) expect(evs).toContain(t);
  });
});
