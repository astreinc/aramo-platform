import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from '../esign.repository.js';
import { EnvelopeIllegalTransitionError } from '../domain/errors.js';
import {
  DisabledEstampAdapter,
  ESTAMP_PORT,
  EstampProviderNotConfiguredError,
  type EstampOrderInput,
  type EstampPort,
} from '../ports/estamp.port.js';

import { RegulatedSigningStateError, RegulatedSigningValidationError } from './regulated-errors.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.19 under Amendment A1 — the
// India e-stamp workflow. Vendor-neutral: the aggregator is reached only through
// EstampPort (no aggregator is selected, so the bound adapter is `disabled`).
//
//   sender (DRAFT) request          → REQUESTED → ORDERED         ESTAMP_REQUESTED, ESTAMP_ORDERED
//   sender (DRAFT) refresh          → (aggregator still pending: no change)
//                                   → ISSUED → ATTACHED           ESTAMP_ISSUED, ESTAMP_ATTACHED
//   any aggregator refusal          → FAILED (a new order may follow) ESTAMP_FAILED
//
// "Attached" means the e-stamp certificate PDF is stored as an OWNED source document and
// placed FIRST (ordinal 0) in the envelope, in front of the documents to sign, before
// the envelope is sent. The send guard (assertSendable) refuses an envelope whose live
// order is not attached in first place.

export const ESTAMP_STATES = ['REQUESTED', 'ORDERED', 'ISSUED', 'ATTACHED', 'FAILED'] as const;
export type EstampState = (typeof ESTAMP_STATES)[number];

export const ESTAMP_EVENT = {
  REQUESTED: 'ESTAMP_REQUESTED',
  ORDERED: 'ESTAMP_ORDERED',
  ISSUED: 'ESTAMP_ISSUED',
  ATTACHED: 'ESTAMP_ATTACHED',
  FAILED: 'ESTAMP_FAILED',
} as const;

// ISO 3166-2:IN subdivision codes (states and union territories), including the codes
// renamed in 2023 (CT→CG, OR→OD, TG→TS, UT→UK) so either form is accepted.
export const INDIA_STATE_CODES: ReadonlySet<string> = new Set(
  ['AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'CT', 'DH', 'DL', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TS', 'TG', 'TR', 'UK', 'UT', 'UP', 'WB'].map((c) => `IN-${c}`),
);
const MAX_PAISE = 10_000_000_000_000; // ₹1,000 crore — far above any single stamp paper.

export interface EstampRequestInput {
  state_code: string;
  article_code: string;
  stamp_duty_amount_paise: number;
  consideration_amount_paise: number | null;
  first_party: string;
  second_party: string;
  purchaser: string;
  description: string | null;
}

export interface EstampOrderView {
  id: string;
  state: EstampState;
  provider: string;
  provider_order_ref: string | null;
  state_code: string;
  article_code: string;
  stamp_duty_amount_paise: number;
  consideration_amount_paise: number | null;
  currency: 'INR';
  first_party: string;
  second_party: string;
  purchaser: string;
  description: string | null;
  certificate_number: string | null;
  certificate_issued_at: string | null;
  certificate_sha256: string | null;
  attached_document_id: string | null;
  failure_reason: string | null;
  created_at: string;
  ordered_at: string | null;
  attached_at: string | null;
}

/** The certificate the aggregator issued, after the caller sanitized and stored it. */
export interface StoredEstampCertificate {
  certificate_number: string;
  issued_at: Date;
  source_object_key: string;
  source_sha256: string;
  byte_size: number;
  pages: readonly { width: number; height: number }[];
}

export type EstampPollResult =
  | { kind: 'none' }
  | { kind: 'unchanged'; order: EstampOrderView }
  | { kind: 'failed'; order: EstampOrderView }
  | { kind: 'issued'; order_id: string; certificate_number: string; issued_at: Date; pdf: Uint8Array };

type OrderRow = NonNullable<Awaited<ReturnType<PrismaService['signEstampOrder']['findFirst']>>>;

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function text(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new RegulatedSigningValidationError(field, 'required');
    return null;
  }
  if (typeof raw !== 'string') throw new RegulatedSigningValidationError(field, 'must be text');
  const v = raw.trim();
  if (v.length > max) throw new RegulatedSigningValidationError(field, `at most ${max} characters`);
  return v;
}

function paise(raw: unknown, field: string, required: boolean, allowZero: boolean): number | null {
  if (raw === undefined || raw === null) {
    if (required) throw new RegulatedSigningValidationError(field, 'required');
    return null;
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < (allowZero ? 0 : 1) || raw > MAX_PAISE) {
    throw new RegulatedSigningValidationError(field, 'must be a whole number of paise');
  }
  return raw;
}

/** Validates the sender's e-stamp request body (amounts in paise). */
export function parseEstampRequest(body: Record<string, unknown> | null | undefined): EstampRequestInput {
  const b = body ?? {};
  const state = text(b['state_code'], 'state_code', 8, true)!.toUpperCase();
  if (!INDIA_STATE_CODES.has(state)) throw new RegulatedSigningValidationError('state_code', 'must be an ISO 3166-2:IN code such as IN-KA');
  return {
    state_code: state,
    article_code: text(b['article_code'], 'article_code', 120, true)!,
    stamp_duty_amount_paise: paise(b['stamp_duty_amount_paise'], 'stamp_duty_amount_paise', true, false)!,
    consideration_amount_paise: paise(b['consideration_amount_paise'], 'consideration_amount_paise', false, true),
    first_party: text(b['first_party'], 'first_party', 200, true)!,
    second_party: text(b['second_party'], 'second_party', 200, true)!,
    purchaser: text(b['purchaser'], 'purchaser', 200, true)!,
    description: text(b['description'], 'description', 500, false),
  };
}

export function estampView(row: OrderRow): EstampOrderView {
  return {
    id: row.id,
    state: row.state as EstampState,
    provider: row.provider,
    provider_order_ref: row.provider_order_ref,
    state_code: row.state_code,
    article_code: row.article_code,
    stamp_duty_amount_paise: Number(row.stamp_duty_amount_paise),
    consideration_amount_paise: row.consideration_amount_paise === null ? null : Number(row.consideration_amount_paise),
    currency: 'INR',
    first_party: row.first_party,
    second_party: row.second_party,
    purchaser: row.purchaser,
    description: row.description,
    certificate_number: row.certificate_number,
    certificate_issued_at: iso(row.certificate_issued_at),
    certificate_sha256: row.certificate_sha256,
    attached_document_id: row.attached_document_id,
    failure_reason: row.failure_reason,
    created_at: row.created_at.toISOString(),
    ordered_at: iso(row.ordered_at),
    attached_at: iso(row.attached_at),
  };
}

@Injectable()
export class EstampWorkflowService {
  private readonly port: EstampPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    // Unbound ⇒ disabled (no aggregator is contracted; Amendment A1).
    @Optional() @Inject(ESTAMP_PORT) port?: EstampPort,
  ) {
    this.port = port ?? new DisabledEstampAdapter();
  }

  get providerConfigured(): boolean {
    return this.port.configured;
  }

  /** The envelope's live (non-FAILED) order, else its most recent one; null when none. */
  async current(tenant_id: string, envelope_id: string): Promise<EstampOrderView | null> {
    const row = await this.currentRow(tenant_id, envelope_id);
    return row === null ? null : estampView(row);
  }

  /** Orders an e-stamp paper for a DRAFT envelope. */
  async request(input: { tenant_id: string; envelope_id: string; actor_ref: string; order: EstampRequestInput }): Promise<EstampOrderView> {
    if (!this.port.configured) throw new EstampProviderNotConfiguredError();
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx as unknown as LockingTx, input.tenant_id, input.envelope_id);
      const live = await tx.signEstampOrder.findFirst({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id, state: { not: 'FAILED' } }, select: { id: true } });
      if (live !== null) throw new RegulatedSigningStateError('estamp_order_exists');
      const o = input.order;
      await tx.signEstampOrder.create({
        data: {
          id,
          tenant_id: input.tenant_id,
          envelope_id: input.envelope_id,
          provider: this.port.provider,
          state_code: o.state_code,
          article_code: o.article_code,
          stamp_duty_amount_paise: BigInt(o.stamp_duty_amount_paise),
          consideration_amount_paise: o.consideration_amount_paise === null ? null : BigInt(o.consideration_amount_paise),
          first_party: o.first_party,
          second_party: o.second_party,
          purchaser: o.purchaser,
          description: o.description,
          requested_by: input.actor_ref,
        },
      });
      await this.event(tx, input.tenant_id, input.envelope_id, input.actor_ref, ESTAMP_EVENT.REQUESTED, {
        order_id: id,
        provider: this.port.provider,
        state_code: o.state_code,
        article_code: o.article_code,
        stamp_duty_amount_paise: o.stamp_duty_amount_paise,
        currency: 'INR',
      });
    });
    const order: EstampOrderInput = { order_id: id, ...input.order };
    let result: Awaited<ReturnType<EstampPort['order']>>;
    try {
      result = await this.port.order(order);
    } catch (e) {
      await this.fail(input.tenant_id, input.envelope_id, id, input.actor_ref, 'provider_error');
      throw e;
    }
    if (result.status === 'FAILED') {
      await this.fail(input.tenant_id, input.envelope_id, id, input.actor_ref, 'provider_refused');
    } else {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.signEstampOrder.update({ where: { id }, data: { state: 'ORDERED', provider_order_ref: result.provider_order_ref, ordered_at: now, updated_at: now } });
        await this.event(tx, input.tenant_id, input.envelope_id, input.actor_ref, ESTAMP_EVENT.ORDERED, { order_id: id, provider_order_ref: result.provider_order_ref });
      });
    }
    const row = await this.prisma.signEstampOrder.findUniqueOrThrow({ where: { id } });
    return estampView(row);
  }

  /** Asks the aggregator for the certificate of the live ORDERED order. */
  async poll(input: { tenant_id: string; envelope_id: string; actor_ref: string }): Promise<EstampPollResult> {
    const row = await this.currentRow(input.tenant_id, input.envelope_id);
    if (row === null) return { kind: 'none' };
    if (row.state !== 'ORDERED' || row.provider_order_ref === null) return { kind: 'unchanged', order: estampView(row) };
    if (!this.port.configured) throw new EstampProviderNotConfiguredError();
    const cert = await this.port.certificate(row.provider_order_ref);
    if (cert.status === 'PENDING') return { kind: 'unchanged', order: estampView(row) };
    if (cert.status === 'FAILED') {
      await this.fail(input.tenant_id, input.envelope_id, row.id, input.actor_ref, cert.reason.slice(0, 120) || 'provider_refused');
      return { kind: 'failed', order: estampView(await this.prisma.signEstampOrder.findUniqueOrThrow({ where: { id: row.id } })) };
    }
    if (cert.certificate_number.trim() === '' || cert.pdf.byteLength === 0) {
      await this.fail(input.tenant_id, input.envelope_id, row.id, input.actor_ref, 'certificate_invalid');
      return { kind: 'failed', order: estampView(await this.prisma.signEstampOrder.findUniqueOrThrow({ where: { id: row.id } })) };
    }
    return { kind: 'issued', order_id: row.id, certificate_number: cert.certificate_number.trim(), issued_at: cert.issued_at, pdf: cert.pdf };
  }

  /**
   * Records the issued certificate (already sanitized and stored by the caller) and places
   * it in FRONT of the envelope's documents, in one transaction on the DRAFT envelope.
   */
  async attach(input: { tenant_id: string; envelope_id: string; actor_ref: string; order_id: string; certificate: StoredEstampCertificate }): Promise<EstampOrderView> {
    const c = input.certificate;
    if (c.pages.length === 0) throw new RegulatedSigningValidationError('certificate', 'has no pages');
    await this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx as unknown as LockingTx, input.tenant_id, input.envelope_id);
      const row = await tx.signEstampOrder.findFirst({ where: { id: input.order_id, tenant_id: input.tenant_id, envelope_id: input.envelope_id } });
      if (row === null || row.state !== 'ORDERED') throw new RegulatedSigningStateError('estamp_not_ordered');
      const now = new Date();
      await tx.signEstampOrder.update({
        where: { id: row.id },
        data: {
          state: 'ISSUED',
          certificate_number: c.certificate_number,
          certificate_issued_at: c.issued_at,
          certificate_sha256: c.source_sha256,
          certificate_object_key: c.source_object_key,
          certificate_page_count: c.pages.length,
          updated_at: now,
        },
      });
      await this.event(tx, input.tenant_id, input.envelope_id, input.actor_ref, ESTAMP_EVENT.ISSUED, {
        order_id: row.id,
        certificate_number: c.certificate_number,
        certificate_sha256: c.source_sha256,
        certificate_page_count: c.pages.length,
      });
      // Place the certificate first: every existing document moves back one place
      // (two passes, as reorder does, so no transient ordinal collides).
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, orderBy: { ordinal: 'asc' }, select: { id: true } });
      for (const [i, d] of docs.entries()) await tx.envelopeDocument.update({ where: { id: d.id }, data: { ordinal: 1000 + i } });
      for (const [i, d] of docs.entries()) await tx.envelopeDocument.update({ where: { id: d.id }, data: { ordinal: i + 1 } });
      const document_id = randomUUID();
      await tx.envelopeDocument.create({
        data: {
          id: document_id,
          tenant_id: input.tenant_id,
          envelope_id: input.envelope_id,
          source_mode: 'OWNED',
          source_object_key: c.source_object_key,
          content_type: 'application/pdf',
          byte_size: c.byte_size,
          title: `e-Stamp certificate ${c.certificate_number}`.slice(0, 200),
          source_sha256: c.source_sha256,
          ordinal: 0,
        },
      });
      await tx.signEnvelopeDocumentPages.create({ data: { envelope_document_id: document_id, tenant_id: input.tenant_id, pages: c.pages.map((p) => ({ width: p.width, height: p.height })) } });
      await tx.signEstampOrder.update({ where: { id: row.id }, data: { state: 'ATTACHED', attached_document_id: document_id, attached_at: now, updated_at: now } });
      await this.event(tx, input.tenant_id, input.envelope_id, input.actor_ref, ESTAMP_EVENT.ATTACHED, {
        order_id: row.id,
        envelope_document_id: document_id,
        certificate_number: c.certificate_number,
        ordinal: 0,
      });
    });
    return estampView(await this.prisma.signEstampOrder.findUniqueOrThrow({ where: { id: input.order_id } }));
  }

  /** Send guard: a live e-stamp order must be ATTACHED, with its certificate first. */
  async assertSendable(tenant_id: string, envelope_id: string): Promise<void> {
    const live = await this.prisma.signEstampOrder.findFirst({ where: { tenant_id, envelope_id, state: { not: 'FAILED' } } });
    if (live === null) return;
    if (live.state !== 'ATTACHED' || live.attached_document_id === null) throw new RegulatedSigningStateError('estamp_not_attached');
    const first = await this.prisma.envelopeDocument.findFirst({ where: { tenant_id, envelope_id }, orderBy: { ordinal: 'asc' }, select: { id: true } });
    if (first?.id !== live.attached_document_id) throw new RegulatedSigningStateError('estamp_not_first');
  }

  private async currentRow(tenant_id: string, envelope_id: string): Promise<OrderRow | null> {
    const live = await this.prisma.signEstampOrder.findFirst({ where: { tenant_id, envelope_id, state: { not: 'FAILED' } } });
    if (live !== null) return live;
    return this.prisma.signEstampOrder.findFirst({ where: { tenant_id, envelope_id }, orderBy: { created_at: 'desc' } });
  }

  private async lockDraft(tx: LockingTx, tenant_id: string, envelope_id: string): Promise<void> {
    const status = await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
    if (status !== 'DRAFT') throw new EnvelopeIllegalTransitionError(status, 'estamp(DRAFT-only)');
  }

  private async fail(tenant_id: string, envelope_id: string, order_id: string, actor_ref: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const n = await tx.signEstampOrder.updateMany({ where: { id: order_id, state: { in: ['REQUESTED', 'ORDERED'] } }, data: { state: 'FAILED', failure_reason: reason, failed_at: now, updated_at: now } });
      if (n.count > 0) await this.event(tx, tenant_id, envelope_id, actor_ref, ESTAMP_EVENT.FAILED, { order_id, reason });
    });
  }

  private event(tx: Parameters<EsignRepository['appendEvent']>[0], tenant_id: string, envelope_id: string, actor_ref: string, event_type: string, payload: Record<string, unknown>): Promise<string> {
    return this.repo.appendEvent(tx, { tenant_id, envelope_id, event_type, actor_type: 'SERVICE', actor_ref, payload });
  }
}
