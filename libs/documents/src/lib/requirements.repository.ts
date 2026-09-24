import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  DocumentNotFoundError,
  DocumentRequirementAlreadySatisfiedError,
  DocumentRequirementNotFoundError,
} from './domain/errors.js';

// DOC-2 boundary 4 — DocumentRequirement, the generic requirement bridge (R12).
// Documents-owned; satisfaction is determined INDEPENDENTLY of any business
// transition. A requirement exists before any document (satisfied_by_document_id
// is nullable). The requirement-check verdict is read-only and never mutates any
// workflow — the owning domain decides whether the business action may proceed.

export interface CreateRequirementInput {
  tenant_id: string;
  document_type_id: string;
  resource_type: string;
  resource_id: string;
  relationship?: string;
  created_by: string;
}

export interface RequirementVerdict {
  requirement_id: string;
  satisfied: boolean;
  status: string;
  satisfied_by_document_id: string | null;
}

@Injectable()
export class RequirementsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createRequirement(input: CreateRequirementInput) {
    return this.prisma.documentRequirement.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        document_type_id: input.document_type_id,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
        relationship: input.relationship ?? null,
        status: 'UNSATISFIED',
        created_by: input.created_by,
      },
    });
  }

  async listRequirements(tenant_id: string, filter?: { resource_type?: string; resource_id?: string }) {
    return this.prisma.documentRequirement.findMany({
      where: {
        tenant_id,
        ...(filter?.resource_type !== undefined ? { resource_type: filter.resource_type } : {}),
        ...(filter?.resource_id !== undefined ? { resource_id: filter.resource_id } : {}),
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getRequirement(tenant_id: string, id: string) {
    const r = await this.prisma.documentRequirement.findFirst({ where: { tenant_id, id } });
    if (r === null) throw new DocumentRequirementNotFoundError(id);
    return r;
  }

  // Read-only verdict. SATISFIED or WAIVED => satisfied. Never mutates anything.
  async checkRequirement(tenant_id: string, id: string): Promise<RequirementVerdict> {
    const r = await this.getRequirement(tenant_id, id);
    return {
      requirement_id: r.id,
      satisfied: r.status === 'SATISFIED' || r.status === 'WAIVED',
      status: r.status,
      satisfied_by_document_id: r.satisfied_by_document_id,
    };
  }

  // Link a Document => SATISFIED. Documents-owned action, independent of any
  // business transition. Idempotent if already satisfied by the SAME document;
  // conflicts if already SATISFIED by a different document or WAIVED.
  async satisfyRequirement(input: { tenant_id: string; id: string; document_id: string; actor_id: string }) {
    const r = await this.getRequirement(input.tenant_id, input.id);
    if (r.status === 'SATISFIED' && r.satisfied_by_document_id === input.document_id) return r; // no-op
    if (r.status !== 'UNSATISFIED') throw new DocumentRequirementAlreadySatisfiedError(input.id, r.status);
    // Tenant-scoped document existence (cross-tenant => NOT FOUND).
    const doc = await this.prisma.document.findFirst({
      where: { tenant_id: input.tenant_id, id: input.document_id },
    });
    if (doc === null) throw new DocumentNotFoundError(input.document_id);
    return this.prisma.documentRequirement.update({
      where: { id: input.id },
      data: { status: 'SATISFIED', satisfied_by_document_id: input.document_id },
    });
  }

  // Waive (document_requirement:manage authority). Conflicts if already resolved.
  async waiveRequirement(input: { tenant_id: string; id: string; reason: string; actor_id: string }) {
    const r = await this.getRequirement(input.tenant_id, input.id);
    if (r.status !== 'UNSATISFIED') throw new DocumentRequirementAlreadySatisfiedError(input.id, r.status);
    return this.prisma.documentRequirement.update({
      where: { id: input.id },
      data: { status: 'WAIVED', waived_by: input.actor_id, waived_reason: input.reason, waived_at: new Date() },
    });
  }
}
