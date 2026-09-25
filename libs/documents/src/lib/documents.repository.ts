import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { DocumentIdempotencyService } from './idempotency.service.js';
import {
  DocumentIdempotencyConflictError,
  DocumentIllegalTransitionError,
  DocumentNotFoundError,
} from './domain/errors.js';

// DOC-1a boundary 3 — transactional write semantics.
//
// PO rule (2026-09-21): a real state change writes the Document row + EXACTLY
// ONE DocumentEvent + EXACTLY ONE OutboxEvent in the SAME $transaction. A no-op
// transition (requested state == current state) appends NEITHER. OutboxEvent
// stays local to the documents schema — the publisher drain is deferred to the
// external-event-bus work in the LOCKED program (not wired here).

export interface DocumentAssociationInput {
  resource_type: string;
  resource_id: string;
  relationship: string;
}

export interface CreateDocumentInput {
  tenant_id: string;
  document_type_id: string;
  title: string;
  execution_mode: string;
  source_kind: string;
  created_by: string;
  associations?: DocumentAssociationInput[];
  correlation_id?: string;
  request_id?: string;
}

export interface PrepareDocumentInput {
  tenant_id: string;
  document_id: string;
  actor_id: string;
  correlation_id?: string;
  request_id?: string;
}

export interface IdempotencyContext {
  key: string;
  request_hash: string;
}

@Injectable()
export class DocumentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: DocumentIdempotencyService,
  ) {}

  async createDocument(input: CreateDocumentInput, idempotency?: IdempotencyContext) {
    if (idempotency !== undefined) {
      const pre = await this.idempotency.lookup(input.tenant_id, idempotency.key, idempotency.request_hash);
      if (pre.kind === 'replay') return this.reloadReplay(input.tenant_id, pre.response_body);
      if (pre.kind === 'conflict') throw new DocumentIdempotencyConflictError(idempotency.key);
    }
    const documentId = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.document.create({
          data: {
            id: documentId,
            tenant_id: input.tenant_id,
            document_type_id: input.document_type_id,
            title: input.title,
            status: 'DRAFT',
            execution_mode: input.execution_mode,
            source_kind: input.source_kind,
            created_by: input.created_by,
          },
        });
        for (const a of input.associations ?? []) {
          await tx.documentAssociation.create({
            data: {
              id: randomUUID(),
              tenant_id: input.tenant_id,
              document_id: documentId,
              resource_type: a.resource_type,
              resource_id: a.resource_id,
              relationship: a.relationship,
              created_by: input.created_by,
            },
          });
        }
        // Exactly one lifecycle event.
        await tx.documentEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: input.tenant_id,
            document_id: documentId,
            event_type: 'DOCUMENT_CREATED',
            actor_type: 'USER',
            actor_id: input.created_by,
            correlation_id: input.correlation_id ?? null,
            request_id: input.request_id ?? null,
            payload: { document_type_id: input.document_type_id },
          },
        });
        // Exactly one outbox row (local; publisher deferred).
        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: input.tenant_id,
            event_type: 'document.created.v1',
            event_payload: { document_id: documentId, document_type_id: input.document_type_id },
          },
        });
        // Consumed-key write inside the SAME transaction (rollback removes it).
        if (idempotency !== undefined) {
          await tx.idempotencyKey.create({
            data: {
              id: randomUUID(),
              tenant_id: input.tenant_id,
              key: idempotency.key,
              request_hash: idempotency.request_hash,
              response_status: 201,
              response_body: { document_id: documentId },
            },
          });
        }
        return tx.document.findFirstOrThrow({ where: { id: documentId } });
      });
    } catch (e) {
      // Concurrent create with the same key collided on the unique index —
      // re-check committed state and replay or conflict.
      if (idempotency !== undefined && DocumentIdempotencyService.isUniqueViolation(e)) {
        const post = await this.idempotency.lookup(input.tenant_id, idempotency.key, idempotency.request_hash);
        if (post.kind === 'replay') return this.reloadReplay(input.tenant_id, post.response_body);
        if (post.kind === 'conflict') throw new DocumentIdempotencyConflictError(idempotency.key);
      }
      throw e;
    }
  }

  async createDocumentType(input: {
    tenant_id: string;
    key: string;
    name: string;
    description?: string;
    scope: string;
    execution_mode_default: string;
    retention_class: string;
  }) {
    return this.prisma.documentType.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        scope: input.scope,
        execution_mode_default: input.execution_mode_default,
        retention_class: input.retention_class,
        system_defined: false,
      },
    });
  }

  async listDocumentTypes(tenant_id: string) {
    // Tenant's own types plus SYSTEM types (tenant_id IS NULL).
    return this.prisma.documentType.findMany({
      where: { OR: [{ tenant_id }, { tenant_id: null }], active: true },
      orderBy: { key: 'asc' },
    });
  }

  async getDocument(tenant_id: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { tenant_id, id } });
    if (doc === null) throw new DocumentNotFoundError(id);
    return doc;
  }

  async listDocuments(tenant_id: string) {
    return this.prisma.document.findMany({ where: { tenant_id }, orderBy: { created_at: 'desc' } });
  }

  async addAssociation(input: {
    tenant_id: string;
    document_id: string;
    resource_type: string;
    resource_id: string;
    relationship: string;
    created_by: string;
  }) {
    // Tenant-scoped existence check (a cross-tenant document is NOT FOUND).
    await this.getDocument(input.tenant_id, input.document_id);
    return this.prisma.documentAssociation.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        document_id: input.document_id,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
        relationship: input.relationship,
        created_by: input.created_by,
      },
    });
  }

  async listEvents(tenant_id: string, document_id: string) {
    await this.getDocument(tenant_id, document_id);
    return this.prisma.documentEvent.findMany({
      where: { tenant_id, document_id },
      orderBy: { occurred_at: 'asc' },
    });
  }

  async listArtifacts(tenant_id: string, document_id: string) {
    await this.getDocument(tenant_id, document_id);
    return this.prisma.documentArtifact.findMany({
      where: { tenant_id, document_id },
      orderBy: { created_at: 'asc' },
    });
  }

  // DOC-5 (R-5-11, PL-1) — the same-document executed predicate. Returns the
  // single canonical Document that, in ONE row, is this tenant's, of the given
  // DocumentType key, status=EXECUTED, and simultaneously satisfies EVERY given
  // association (each `some` scoped to the SAME document's associations relation
  // via a distinct AND clause). Opaque refs only — no ATS import. NOT satisfied
  // by separate documents, a single association alone, or a non-EXECUTED status.
  async findExecutedByTypeAndAssociations(input: {
    tenant_id: string;
    document_type_key: string;
    associations: readonly { resource_type: string; resource_id: string; relationship: string }[];
  }) {
    return this.prisma.document.findFirst({
      where: {
        tenant_id: input.tenant_id,
        status: 'EXECUTED',
        document_type: { key: input.document_type_key },
        AND: input.associations.map((a) => ({
          associations: { some: { resource_type: a.resource_type, resource_id: a.resource_id, relationship: a.relationship } },
        })),
      },
    });
  }

  // Requisition Talent Board (TB-4) — BATCHED: the SET of talent ids that have an EXECUTED
  // document of this type jointly associated to the EXACT requisition (REGARDING) AND to
  // themselves as SUBJECT — the same-document predicate, evaluated for a whole talent set in
  // ONE query (never a per-talent `findExecutedByTypeAndAssociations` loop — directive §19).
  // Read-only; tenant-scoped. Empty talent set → empty Set.
  async findExecutedSubjectTalentIds(input: {
    tenant_id: string;
    document_type_key: string;
    requisition_id: string;
    talent_ids: readonly string[];
  }): Promise<Set<string>> {
    const out = new Set<string>();
    if (input.talent_ids.length === 0) return out;
    const wanted = new Set(input.talent_ids);
    const docs = await this.prisma.document.findMany({
      where: {
        tenant_id: input.tenant_id,
        status: 'EXECUTED',
        document_type: { key: input.document_type_key },
        AND: [
          { associations: { some: { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' } } },
          { associations: { some: { resource_type: 'TALENT', resource_id: { in: Array.from(wanted) }, relationship: 'SUBJECT' } } },
        ],
      },
      select: {
        associations: {
          where: { resource_type: 'TALENT', relationship: 'SUBJECT' },
          select: { resource_id: true },
        },
      },
    });
    for (const d of docs) {
      for (const a of d.associations) {
        if (wanted.has(a.resource_id)) out.add(a.resource_id);
      }
    }
    return out;
  }

  // DOC-5 (R-5-11) — is a document of this type REQUIRED for a resource? Returns
  // the DocumentRequirement (or null). The readiness gate uses this to stay
  // CONDITIONAL: a submit is gated on RTR ONLY when such a requirement exists, so
  // submits with no RTR requirement are never denied. Opaque refs; no ATS import.
  async findRequirement(input: {
    tenant_id: string;
    document_type_id: string;
    resource_type: string;
    resource_id: string;
  }) {
    return this.prisma.documentRequirement.findFirst({
      where: {
        tenant_id: input.tenant_id,
        document_type_id: input.document_type_id,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
      },
    });
  }

  // DOC-5 (R-5-11) — idempotently ensure a document requirement exists for a
  // resource (the readiness gate's CONDITIONAL trigger). Returns the existing or
  // newly-created UNSATISFIED requirement. Opaque refs; no ATS import.
  async ensureRequirement(input: {
    tenant_id: string;
    document_type_id: string;
    resource_type: string;
    resource_id: string;
    created_by: string;
  }) {
    const existing = await this.findRequirement(input);
    if (existing !== null) return existing;
    return this.prisma.documentRequirement.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        document_type_id: input.document_type_id,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
        status: 'UNSATISFIED',
        created_by: input.created_by,
      },
    });
  }

  private async reloadReplay(tenant_id: string, responseBody: unknown) {
    const id = (responseBody as { document_id?: string } | null)?.document_id;
    if (id === undefined) {
      throw new Error('idempotency replay: stored response_body missing document_id');
    }
    return this.prisma.document.findFirstOrThrow({ where: { tenant_id, id } });
  }

  async prepareDocument(input: PrepareDocumentInput) {
    const existing = await this.prisma.document.findFirst({
      where: { tenant_id: input.tenant_id, id: input.document_id },
    });
    if (existing === null) {
      throw new DocumentNotFoundError(input.document_id);
    }
    // No-op rule: requested state == current state -> append NOTHING.
    if (existing.status === 'PREPARED') {
      return existing;
    }
    if (existing.status !== 'DRAFT') {
      throw new DocumentIllegalTransitionError(existing.status, 'PREPARED');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: input.document_id },
        data: { status: 'PREPARED', prepared_at: new Date() },
      });
      await tx.documentEvent.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          document_id: input.document_id,
          event_type: 'DOCUMENT_PREPARED',
          actor_type: 'USER',
          actor_id: input.actor_id,
          correlation_id: input.correlation_id ?? null,
          request_id: input.request_id ?? null,
          payload: {},
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          event_type: 'document.prepared.v1',
          event_payload: { document_id: input.document_id },
        },
      });
      return tx.document.findFirstOrThrow({ where: { id: input.document_id } });
    });
  }
}
