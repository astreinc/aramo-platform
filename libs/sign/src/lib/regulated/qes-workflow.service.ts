import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from '../esign.repository.js';
import { EnvelopeIllegalTransitionError, SignerNotFoundError } from '../domain/errors.js';
import { recipientKindOf } from '../domain/recipients.js';
import {
  DisabledQesSigningAdapter,
  QES_SIGNING_PORT,
  QesProviderError,
  QesProviderNotConfiguredError,
  type QesSigningPort,
} from '../ports/qes-signing.port.js';

import {
  certificateChainSha256,
  isParsableChain,
  qesSigningDigest,
  RSA_SHA256_SIGNATURE_OID,
  sha256Hex,
  signerCertificateSummary,
  verifyQesSignature,
  type CertificateSummary,
} from './qes-evidence.js';
import { RegulatedSigningStateError, RegulatedSigningValidationError } from './regulated-errors.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.16 under Amendment A1 — the
// per-signer QES workflow. Vendor-neutral: every QTSP call goes through QesSigningPort.
//
//   sender (DRAFT)   setSignatureLevel(QES)   → REQUIRED                  QES_LEVEL_SET
//   signer (session) beginIdentity           → IDENTITY_PROOFING_PENDING QES_IDENTITY_PROOFING_STARTED
//   QTSP callback    complete (phase 1)      → AUTHORIZED                QES_AUTHORIZED
//   QTSP callback    complete (phase 2)      → SIGNED                    QES_SIGNED
//   any QTSP refusal                          → FAILED (restartable)      QES_FAILED
//
// A signer whose row is not SIGNED cannot complete signing (assertQesSatisfied, called
// by EsignService.completeSigner). Every step appends a hash-chained ledger event with
// non-secret evidence only; no OAuth token or code is ever stored or logged.

export const QES_SIGNATURE_LEVELS = ['STANDARD', 'QES'] as const;
export type QesSignatureLevel = (typeof QES_SIGNATURE_LEVELS)[number];
export const QES_STATES = ['REQUIRED', 'IDENTITY_PROOFING_PENDING', 'AUTHORIZED', 'SIGNED', 'FAILED'] as const;
export type QesState = (typeof QES_STATES)[number];

export const QES_EVENT = {
  LEVEL_SET: 'QES_LEVEL_SET',
  IDENTITY_PROOFING_STARTED: 'QES_IDENTITY_PROOFING_STARTED',
  AUTHORIZED: 'QES_AUTHORIZED',
  SIGNATURE_AUTHORIZATION_STARTED: 'QES_SIGNATURE_AUTHORIZATION_STARTED',
  SIGNED: 'QES_SIGNED',
  FAILED: 'QES_FAILED',
} as const;

const SIGNING_STATUSES = new Set(['SENT', 'IN_PROGRESS']);
const MAX_CODE = 2048;
const MAX_STATE = 256;

export interface QesSessionRef {
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
}

export interface QesSignatureView {
  signer_id: string;
  signature_level: 'QES';
  state: QesState;
  provider: string | null;
  certificate: CertificateSummary | null;
  certificate_chain_sha256: string | null;
  signature_sha256: string | null;
  qtsp_reference: string | null;
  failure_reason: string | null;
  identity_started_at: string | null;
  authorized_at: string | null;
  signed_at: string | null;
}

export interface QesStepResult {
  state: QesState;
  /** Where to send the signer next (the QTSP), or null when the flow is finished. */
  redirect_url: string | null;
}

type QesRow = NonNullable<Awaited<ReturnType<PrismaService['signQesSignature']['findFirst']>>>;

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function nonce(row_id: string): string {
  return `${row_id}.${randomBytes(24).toString('base64url')}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function qesView(row: QesRow): QesSignatureView {
  return {
    signer_id: row.signer_id,
    signature_level: 'QES',
    state: row.state as QesState,
    provider: row.provider,
    certificate: signerCertificateSummary(row.certificate_chain_pem),
    certificate_chain_sha256: row.certificate_chain_sha256,
    signature_sha256: row.signature_sha256,
    qtsp_reference: row.qtsp_reference,
    failure_reason: row.failure_reason,
    identity_started_at: iso(row.identity_started_at),
    authorized_at: iso(row.authorized_at),
    signed_at: iso(row.signed_at),
  };
}

@Injectable()
export class QesWorkflowService {
  private readonly port: QesSigningPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    // Unbound ⇒ disabled (no QTSP is contracted; Amendment A1).
    @Optional() @Inject(QES_SIGNING_PORT) port?: QesSigningPort,
  ) {
    this.port = port ?? new DisabledQesSigningAdapter();
  }

  get providerConfigured(): boolean {
    return this.port.configured;
  }

  // ── Sender (DRAFT) ─────────────────────────────────────────────────────────

  /** Sets one signer's signature level on a DRAFT. QES needs a configured QTSP. */
  async setSignatureLevel(input: { tenant_id: string; envelope_id: string; signer_id: string; level: string; actor_ref: string }): Promise<QesSignatureView[]> {
    if (!(QES_SIGNATURE_LEVELS as readonly string[]).includes(input.level)) {
      throw new RegulatedSigningValidationError('signature_level', 'must be STANDARD or QES');
    }
    if (input.level === 'QES' && !this.port.configured) throw new QesProviderNotConfiguredError();
    await this.prisma.$transaction(async (tx) => {
      const status = await this.repo.lockEnvelope(tx as unknown as LockingTx, input.tenant_id, input.envelope_id);
      if (status !== 'DRAFT') throw new EnvelopeIllegalTransitionError(status, 'signature_level(DRAFT-only)');
      const signer = await tx.signer.findFirst({ where: { id: input.signer_id, tenant_id: input.tenant_id, envelope_id: input.envelope_id } });
      if (signer === null) throw new SignerNotFoundError(input.signer_id);
      // The QTSP proofs and authorizes the signer remotely: a copy recipient never signs,
      // and a hosted (in-person) signer has no device of their own to authorize on.
      if (recipientKindOf(signer) !== 'SIGNER') throw new RegulatedSigningStateError('qes_requires_remote_signer');
      const existing = await tx.signQesSignature.findFirst({ where: { tenant_id: input.tenant_id, signer_id: input.signer_id } });
      if (input.level === 'QES') {
        if (existing !== null) return;
        await tx.signQesSignature.create({
          data: { id: randomUUID(), tenant_id: input.tenant_id, envelope_id: input.envelope_id, signer_id: input.signer_id, requested_by: input.actor_ref },
        });
      } else {
        if (existing === null) return;
        await tx.signQesSignature.delete({ where: { id: existing.id } });
      }
      await this.repo.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        signer_id: input.signer_id,
        event_type: QES_EVENT.LEVEL_SET,
        actor_type: 'SERVICE',
        actor_ref: input.actor_ref,
        payload: { signer_id: input.signer_id, signature_level: input.level },
      });
    });
    return this.list(input.tenant_id, input.envelope_id);
  }

  async list(tenant_id: string, envelope_id: string): Promise<QesSignatureView[]> {
    const rows = await this.prisma.signQesSignature.findMany({ where: { tenant_id, envelope_id }, orderBy: { created_at: 'asc' } });
    return rows.map(qesView);
  }

  async forSigner(ref: QesSessionRef): Promise<QesSignatureView | null> {
    const row = await this.prisma.signQesSignature.findFirst({ where: { tenant_id: ref.tenant_id, envelope_id: ref.envelope_id, signer_id: ref.signer_id } });
    return row === null ? null : qesView(row);
  }

  /** Send guard: an envelope with a QES signer is not sent while no QTSP is configured. */
  async assertSendable(tenant_id: string, envelope_id: string): Promise<void> {
    const n = await this.prisma.signQesSignature.count({ where: { tenant_id, envelope_id } });
    if (n > 0 && !this.port.configured) throw new QesProviderNotConfiguredError();
  }

  // ── Signer (a live signing session) ────────────────────────────────────────

  /** Phase 1 start: send the signer to the QTSP for identity proofing. */
  async beginIdentity(ref: QesSessionRef, redirect_uri: string): Promise<QesStepResult> {
    if (!this.port.configured) throw new QesProviderNotConfiguredError();
    const { row, signer } = await this.signerRow(ref);
    if (row.state === 'SIGNED') throw new RegulatedSigningStateError('qes_already_signed');
    const state = nonce(row.id);
    const { redirect_url } = await this.callPort(ref, row.id, () =>
      this.port.beginIdentity({ state, redirect_uri, signer: { name: signer.name, email: signer.email } }),
    );
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx as unknown as LockingTx, ref.tenant_id, ref.envelope_id);
      const now = new Date();
      await tx.signQesSignature.update({
        where: { id: row.id },
        data: {
          state: 'IDENTITY_PROOFING_PENDING',
          provider: this.port.provider,
          pending_state_sha256: sha256(state),
          identity_started_at: now,
          updated_at: now,
          // A restart after a failure clears the earlier attempt.
          credential_id: null,
          certificate_chain_pem: [],
          certificate_chain_sha256: null,
          authorization_level: null,
          authorized_at: null,
          failure_reason: null,
          failed_at: null,
        },
      });
      await this.event(tx, ref, QES_EVENT.IDENTITY_PROOFING_STARTED, { provider: this.port.provider });
    });
    return { state: 'IDENTITY_PROOFING_PENDING', redirect_url };
  }

  /**
   * The QTSP redirected back with an authorization code. Phase 1 (identity) moves the
   * row to AUTHORIZED and returns the phase 2 URL; phase 2 signs and moves it to SIGNED.
   */
  async complete(ref: QesSessionRef, input: { state: string; code: string; redirect_uri: string }): Promise<QesStepResult> {
    if (!this.port.configured) throw new QesProviderNotConfiguredError();
    if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > MAX_CODE) throw new RegulatedSigningValidationError('code', 'required');
    if (typeof input.state !== 'string' || input.state.length === 0 || input.state.length > MAX_STATE) throw new RegulatedSigningValidationError('state', 'required');
    const { row } = await this.signerRow(ref);
    if (row.pending_state_sha256 === null || row.pending_state_sha256 !== sha256(input.state)) throw new RegulatedSigningStateError('qes_state_mismatch');
    if (row.state === 'IDENTITY_PROOFING_PENDING') return this.completeIdentity(ref, row, input);
    if (row.state === 'AUTHORIZED') return this.completeSignature(ref, row, input);
    throw new RegulatedSigningStateError(`qes_state_${row.state.toLowerCase()}`);
  }

  private async completeIdentity(ref: QesSessionRef, row: QesRow, input: { code: string; redirect_uri: string }): Promise<QesStepResult> {
    const credential = await this.callPort(ref, row.id, () => this.port.completeIdentity({ authorization_code: input.code, redirect_uri: input.redirect_uri }));
    if (credential.credential_id.trim() === '' || !isParsableChain(credential.certificate_chain_pem)) {
      await this.fail(ref, row.id, 'qtsp_credential_invalid');
      throw new QesProviderError('qtsp_credential_invalid');
    }
    const algorithm = credential.signature_algorithm_oids[0] ?? RSA_SHA256_SIGNATURE_OID;
    const docs = await this.prisma.envelopeDocument.findMany({ where: { tenant_id: ref.tenant_id, envelope_id: ref.envelope_id }, select: { id: true, ordinal: true, source_sha256: true } });
    const digest = qesSigningDigest({ envelope_id: ref.envelope_id, signer_id: ref.signer_id, documents: docs });
    const chainSha = certificateChainSha256(credential.certificate_chain_pem);
    const state = nonce(row.id);
    const { redirect_url } = await this.callPort(ref, row.id, () =>
      this.port.beginSignature({ state, redirect_uri: input.redirect_uri, credential_id: credential.credential_id, hash_b64: digest.digest_b64, hash_algorithm_oid: digest.hash_algorithm_oid }),
    );
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx as unknown as LockingTx, ref.tenant_id, ref.envelope_id);
      const now = new Date();
      await tx.signQesSignature.update({
        where: { id: row.id },
        data: {
          state: 'AUTHORIZED',
          credential_id: credential.credential_id,
          certificate_chain_pem: credential.certificate_chain_pem,
          certificate_chain_sha256: chainSha,
          authorization_level: credential.authorization_level,
          signature_algorithm_oid: algorithm,
          hash_algorithm_oid: digest.hash_algorithm_oid,
          signed_digest_b64: digest.digest_b64,
          pending_state_sha256: sha256(state),
          authorized_at: now,
          updated_at: now,
        },
      });
      const cert = signerCertificateSummary(credential.certificate_chain_pem);
      await this.event(tx, ref, QES_EVENT.AUTHORIZED, {
        provider: this.port.provider,
        certificate_chain_sha256: chainSha,
        certificate_subject: cert?.subject ?? null,
        certificate_issuer: cert?.issuer ?? null,
        certificate_serial_number: cert?.serial_number ?? null,
        authorization_level: credential.authorization_level,
      });
      await this.event(tx, ref, QES_EVENT.SIGNATURE_AUTHORIZATION_STARTED, { signed_digest_b64: digest.digest_b64, hash_algorithm_oid: digest.hash_algorithm_oid });
    });
    return { state: 'AUTHORIZED', redirect_url };
  }

  private async completeSignature(ref: QesSessionRef, row: QesRow, input: { code: string; redirect_uri: string }): Promise<QesStepResult> {
    if (row.credential_id === null || row.signed_digest_b64 === null || row.hash_algorithm_oid === null || row.signature_algorithm_oid === null) {
      throw new RegulatedSigningStateError('qes_not_authorized');
    }
    const credential_id = row.credential_id;
    const digest_b64 = row.signed_digest_b64;
    const hash_algorithm_oid = row.hash_algorithm_oid;
    const signature_algorithm_oid = row.signature_algorithm_oid;
    const result = await this.callPort(ref, row.id, () =>
      this.port.signHash({ authorization_code: input.code, redirect_uri: input.redirect_uri, credential_id, hash_b64: digest_b64, hash_algorithm_oid, signature_algorithm_oid }),
    );
    const signerCert = row.certificate_chain_pem[0];
    const verified = signerCert === undefined ? false : verifyQesSignature({ certificate_pem: signerCert, digest_b64, signature_b64: result.signature_b64, signature_algorithm_oid });
    if (result.signature_b64.length === 0 || verified === false) {
      await this.fail(ref, row.id, 'qtsp_signature_invalid');
      throw new QesProviderError('qtsp_signature_invalid');
    }
    const signatureSha = sha256Hex(result.signature_b64);
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx as unknown as LockingTx, ref.tenant_id, ref.envelope_id);
      const now = new Date();
      await tx.signQesSignature.update({
        where: { id: row.id },
        data: { state: 'SIGNED', signature_value_b64: result.signature_b64, signature_sha256: signatureSha, qtsp_reference: result.qtsp_reference, pending_state_sha256: null, signed_at: now, updated_at: now },
      });
      await this.event(tx, ref, QES_EVENT.SIGNED, {
        provider: this.port.provider,
        signature_level: 'QES',
        signature_sha256: signatureSha,
        certificate_chain_sha256: row.certificate_chain_sha256,
        signed_digest_b64: digest_b64,
        hash_algorithm_oid,
        signature_algorithm_oid,
        // true: checked locally against the signer certificate; null: algorithm not checked locally.
        signature_verified: verified,
        qtsp_reference: result.qtsp_reference,
      });
    });
    return { state: 'SIGNED', redirect_url: null };
  }

  private async signerRow(ref: QesSessionRef) {
    const env = await this.prisma.signatureEnvelope.findFirst({ where: { id: ref.envelope_id, tenant_id: ref.tenant_id }, select: { status: true } });
    if (env === null || !SIGNING_STATUSES.has(env.status)) throw new RegulatedSigningStateError('envelope_not_signable');
    const row = await this.prisma.signQesSignature.findFirst({ where: { tenant_id: ref.tenant_id, envelope_id: ref.envelope_id, signer_id: ref.signer_id } });
    if (row === null) throw new RegulatedSigningStateError('qes_not_required');
    const signer = await this.prisma.signer.findFirstOrThrow({ where: { id: ref.signer_id, tenant_id: ref.tenant_id }, select: { name: true, email: true, status: true } });
    if (signer.status === 'SIGNED' || signer.status === 'DECLINED') throw new RegulatedSigningStateError('signer_finished');
    return { row, signer };
  }

  // Runs one QTSP call; a refusal marks the row FAILED (restartable) and is rethrown.
  private async callPort<T>(ref: QesSessionRef, row_id: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof QesProviderNotConfiguredError) throw e;
      const reason = e instanceof QesProviderError ? e.reason : 'qtsp_unreachable';
      await this.fail(ref, row_id, reason);
      throw e instanceof QesProviderError ? e : new QesProviderError(reason);
    }
  }

  private async fail(ref: QesSessionRef, row_id: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const n = await tx.signQesSignature.updateMany({
        where: { id: row_id, state: { not: 'SIGNED' } },
        data: { state: 'FAILED', failure_reason: reason, failed_at: now, pending_state_sha256: null, updated_at: now, credential_id: null, certificate_chain_pem: [], certificate_chain_sha256: null, authorized_at: null },
      });
      if (n.count > 0) await this.event(tx, ref, QES_EVENT.FAILED, { provider: this.port.provider, reason });
    });
  }

  private event(tx: Parameters<EsignRepository['appendEvent']>[0], ref: QesSessionRef, event_type: string, payload: Record<string, unknown>): Promise<string> {
    return this.repo.appendEvent(tx, {
      tenant_id: ref.tenant_id,
      envelope_id: ref.envelope_id,
      signer_id: ref.signer_id,
      event_type,
      actor_type: 'SIGNER',
      actor_ref: ref.signer_id,
      payload: { signer_id: ref.signer_id, ...payload },
    });
  }
}
