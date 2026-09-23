import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { computeEventHash } from './hash-chain.js';
import { EnvelopeNotFoundError, SignerNotFoundError } from './domain/errors.js';

// DOC-3 boundary 1-2 — E-Sign persistence + append-only hash-chained event
// ledger. ATS-neutral: Documents referenced by opaque UUID only. Any Prisma tx
// client works for the transactional helpers.

type Tx = Pick<PrismaService, 'signatureEnvelope' | 'signer' | 'signatureField' | 'signatureEvent' | 'envelopeDocument' | 'signingSession' | 'signerDisclosureAcceptance' | 'outboxEvent' | 'idempotencyKey'>;

export interface CreateEnvelopeInput {
  tenant_id: string;
  subject: string;
  execution_mode: string;
  created_by: string;
}

export interface AddDocumentInput {
  tenant_id: string;
  envelope_id: string;
  document_ref: string;
  document_revision_ref: string;
  title: string;
  source_sha256: string;
  ordinal: number;
}

export interface AddSignerInput {
  tenant_id: string;
  envelope_id: string;
  email: string;
  name: string;
  signing_order: number;
  signer_role?: string;
}

export interface AddFieldInput {
  tenant_id: string;
  envelope_document_id: string;
  signer_id?: string;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  required?: boolean;
}

export interface AppendEventInput {
  tenant_id: string;
  envelope_id: string;
  signer_id?: string;
  event_type: string;
  actor_type: string; // SIGNER|SYSTEM|SERVICE
  actor_ref?: string;
  payload?: unknown;
  ip_address?: string;
  user_agent?: string;
}

@Injectable()
export class EsignRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Append-only hash-chained event (R20/§256). Reads the current terminal
  // event for the envelope and chains from it. Call once per operation. ──
  async appendEvent(tx: Tx, input: AppendEventInput): Promise<string> {
    const prev = await tx.signatureEvent.findFirst({
      where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      select: { event_hash: true },
    });
    const occurredAt = new Date();
    const previousHash = prev?.event_hash ?? null;
    const eventHash = computeEventHash(previousHash, {
      envelope_id: input.envelope_id,
      event_type: input.event_type,
      actor_type: input.actor_type,
      actor_ref: input.actor_ref ?? null,
      payload: input.payload ?? null,
      occurred_at: occurredAt.toISOString(),
    });
    const id = randomUUID();
    await tx.signatureEvent.create({
      data: {
        id,
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        signer_id: input.signer_id ?? null,
        event_type: input.event_type,
        actor_type: input.actor_type,
        actor_ref: input.actor_ref ?? null,
        payload: (input.payload ?? undefined) as never,
        previous_event_hash: previousHash,
        event_hash: eventHash,
        occurred_at: occurredAt,
        ip_address: input.ip_address ?? null,
        user_agent: input.user_agent ?? null,
      },
    });
    return eventHash;
  }

  async createEnvelope(input: CreateEnvelopeInput) {
    const id = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const env = await tx.signatureEnvelope.create({
        data: {
          id,
          tenant_id: input.tenant_id,
          subject: input.subject,
          status: 'DRAFT',
          execution_mode: input.execution_mode,
          created_by: input.created_by,
        },
      });
      await this.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: id,
        event_type: 'ENVELOPE_CREATED',
        actor_type: 'SERVICE',
        actor_ref: input.created_by,
        payload: { execution_mode: input.execution_mode },
      });
      return env;
    });
  }

  async getEnvelope(tenant_id: string, id: string) {
    const env = await this.prisma.signatureEnvelope.findFirst({ where: { tenant_id, id } });
    if (env === null) throw new EnvelopeNotFoundError(id);
    return env;
  }

  async getEnvelopeFull(tenant_id: string, id: string) {
    const env = await this.prisma.signatureEnvelope.findFirst({
      where: { tenant_id, id },
      include: {
        documents: { orderBy: { ordinal: 'asc' }, include: { fields: true } },
        signers: { orderBy: { signing_order: 'asc' } },
      },
    });
    if (env === null) throw new EnvelopeNotFoundError(id);
    return env;
  }

  async addDocument(input: AddDocumentInput) {
    await this.getEnvelope(input.tenant_id, input.envelope_id);
    return this.prisma.envelopeDocument.create({ data: { id: randomUUID(), ...input } });
  }

  async addSigner(input: AddSignerInput) {
    await this.getEnvelope(input.tenant_id, input.envelope_id);
    return this.prisma.signer.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        email: input.email,
        name: input.name,
        signing_order: input.signing_order,
        signer_role: input.signer_role ?? null,
        status: 'PENDING',
      },
    });
  }

  async getSigner(tenant_id: string, id: string) {
    const s = await this.prisma.signer.findFirst({ where: { tenant_id, id } });
    if (s === null) throw new SignerNotFoundError(id);
    return s;
  }

  async addField(input: AddFieldInput) {
    return this.prisma.signatureField.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        envelope_document_id: input.envelope_document_id,
        signer_id: input.signer_id ?? null,
        field_type: input.field_type,
        page_number: input.page_number,
        x: input.x,
        y: input.y,
        width: input.width ?? null,
        height: input.height ?? null,
        required: input.required ?? true,
      },
    });
  }

  async listSignerRequiredFields(tenant_id: string, signer_id: string) {
    return this.prisma.signatureField.findMany({ where: { tenant_id, signer_id, required: true } });
  }

  // Transactional envelope status change + single hash-chained event.
  async transitionEnvelope(input: {
    tenant_id: string;
    envelope_id: string;
    to: string;
    event_type: string;
    actor_type: string;
    actor_ref?: string;
    timestampField?: 'sent_at' | 'completed_at' | 'declined_at' | 'voided_at';
    payload?: unknown;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { status: input.to };
      if (input.timestampField) data[input.timestampField] = new Date();
      await tx.signatureEnvelope.update({ where: { id: input.envelope_id }, data });
      await this.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        event_type: input.event_type,
        actor_type: input.actor_type,
        actor_ref: input.actor_ref,
        payload: input.payload,
      });
      return tx.signatureEnvelope.findFirstOrThrow({ where: { id: input.envelope_id } });
    });
  }

  async listEvents(tenant_id: string, envelope_id: string) {
    await this.getEnvelope(tenant_id, envelope_id);
    return this.prisma.signatureEvent.findMany({
      where: { tenant_id, envelope_id },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    });
  }

  async terminalEventHash(tenant_id: string, envelope_id: string): Promise<string | null> {
    const last = await this.prisma.signatureEvent.findFirst({
      where: { tenant_id, envelope_id },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      select: { event_hash: true },
    });
    return last?.event_hash ?? null;
  }
}
