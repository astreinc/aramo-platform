import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { DocumentTypeConflictError, DocumentTypeNotFoundError } from './domain/errors.js';
import { SYSTEM_LOCKED_EDITABLE_FIELDS, isSystemLockedType, type DocumentTypeTemplateKind } from './document-types.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4.3 — Platform Admin management
// of the SYSTEM document types (tenant_id NULL, scope SYSTEM). Called ONLY by the platform-tier
// controller (apps/api, consumer_type=platform + platform:document_template:*). A TENANT /
// CLIENT document type is never reachable here (404).
//
// Every write takes a `beforeWrite` hook that runs after every state check and before the
// write (the controller writes the GLOBAL audit event there — no change without its audit
// record; a failing hook aborts the change). Each write locks the type row FOR UPDATE, so the
// "has a template" checks cannot race a concurrent template create under the same type
// (DocumentTemplate.document_type_id → DocumentType FK takes a KEY SHARE lock on it).

export interface PlatformDocumentTypeRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: string;
  type_class: string;
  template_kind: string | null;
  products: string[];
  category: string | null;
  retention_class: string;
  execution_mode_default: string;
  system_defined: boolean;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSystemDocumentTypeInput {
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  template_kind: DocumentTypeTemplateKind;
  products: string[];
  retention_class: string;
  execution_mode_default: string;
}

export interface UpdateSystemDocumentTypeInput {
  name?: string;
  description?: string | null;
  category?: string | null;
  template_kind?: DocumentTypeTemplateKind;
  products?: string[];
  retention_class?: string;
  execution_mode_default?: string;
}

type Hook<T> = (planned: T) => Promise<void>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

@Injectable()
export class PlatformDocumentTypesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Every SYSTEM type (both classes, active and retired), with the templates of any owner
  // that use it and whether an Aramo default of it is live (the screen's columns).
  async listWithUsage(): Promise<Array<PlatformDocumentTypeRow & { templates_count: number; live_default: boolean }>> {
    const rows = await this.prisma.documentType.findMany({ where: { tenant_id: null }, orderBy: [{ name: 'asc' }, { key: 'asc' }] });
    const counts = await this.prisma.documentTemplate.groupBy({ by: ['document_type_id'], _count: { _all: true } });
    const live = await this.prisma.documentTemplate.findMany({
      where: { owner_scope: 'PLATFORM', tenant_id: null, status: 'ACTIVE', withdraw_effective_at: null },
      select: { document_type_id: true },
    });
    const byType = new Map(counts.map((c) => [c.document_type_id, c._count._all]));
    const liveTypes = new Set(live.map((l) => l.document_type_id));
    return rows.map((r) => ({ ...r, templates_count: byType.get(r.id) ?? 0, live_default: liveTypes.has(r.id) }));
  }

  // The retention classes already in use on document types (the dialog's choices).
  async listRetentionClasses(): Promise<string[]> {
    const rows = await this.prisma.documentType.findMany({ distinct: ['retention_class'], select: { retention_class: true }, orderBy: { retention_class: 'asc' } });
    return rows.map((r) => r.retention_class);
  }

  async getSystemType(id: string): Promise<PlatformDocumentTypeRow> {
    const t = await this.prisma.documentType.findFirst({ where: { id, tenant_id: null } });
    if (t === null) throw new DocumentTypeNotFoundError(id);
    return t;
  }

  // POST — a new SYSTEM TEMPLATE type (scope SYSTEM, system_defined false). The key is the
  // caller's (derived from the name); a taken key is key_exists (the partial unique index
  // DocumentType_system_key_key is the race backstop, mapped to the same refusal).
  async create(input: CreateSystemDocumentTypeInput, beforeWrite?: Hook<{ id: string; key: string; name: string }>): Promise<PlatformDocumentTypeRow> {
    const taken = await this.prisma.documentType.findFirst({ where: { tenant_id: null, key: input.key }, select: { id: true } });
    if (taken !== null) throw new DocumentTypeConflictError(null, 'key_exists', { key: input.key });
    const id = randomUUID();
    if (beforeWrite !== undefined) await beforeWrite({ id, key: input.key, name: input.name });
    try {
      return await this.prisma.documentType.create({
        data: {
          id,
          tenant_id: null,
          key: input.key,
          name: input.name,
          description: input.description,
          scope: 'SYSTEM',
          execution_mode_default: input.execution_mode_default,
          retention_class: input.retention_class,
          system_defined: false,
          active: true,
          type_class: 'TEMPLATE',
          template_kind: input.template_kind,
          products: input.products,
          category: input.category,
        },
      });
    } catch (e) {
      if (driverMessage(e).includes('DocumentType_system_key_key')) throw new DocumentTypeConflictError(null, 'key_exists', { key: input.key });
      throw e;
    }
  }

  // PATCH — only fields that actually change are checked and written (a dialog may send the
  // whole form). UPLOAD types are read-only; a system-locked type accepts only its editable
  // fields (§4.2); once the type has a template (any owner) its kind is fixed and a product
  // can't be removed (products can be added). Returns the row and the changed field names.
  async update(
    id: string,
    patch: UpdateSystemDocumentTypeInput,
    beforeWrite?: Hook<{ type: PlatformDocumentTypeRow; changed_fields: string[] }>,
  ): Promise<{ type: PlatformDocumentTypeRow; changed_fields: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const t = await tx.documentType.findFirstOrThrow({ where: { id } });
      const changed: string[] = [];
      if (patch.name !== undefined && patch.name !== t.name) changed.push('name');
      if (patch.description !== undefined && patch.description !== t.description) changed.push('description');
      if (patch.category !== undefined && patch.category !== t.category) changed.push('category');
      if (patch.template_kind !== undefined && patch.template_kind !== t.template_kind) changed.push('template_kind');
      if (patch.products !== undefined && !sameSet(patch.products, t.products)) changed.push('products');
      if (patch.retention_class !== undefined && patch.retention_class !== t.retention_class) changed.push('retention_class');
      if (patch.execution_mode_default !== undefined && patch.execution_mode_default !== t.execution_mode_default) changed.push('execution_mode_default');
      if (changed.length === 0) return { type: t, changed_fields: [] };
      if (t.type_class === 'UPLOAD') throw new DocumentTypeConflictError(id, 'upload_type');
      if (isSystemLockedType(id)) {
        const allowed = SYSTEM_LOCKED_EDITABLE_FIELDS[id] ?? [];
        const locked = changed.filter((f) => !allowed.includes(f));
        if (locked.length > 0) throw new DocumentTypeConflictError(id, 'system_locked', { fields: locked });
      }
      if (changed.includes('template_kind') || (changed.includes('products') && t.products.some((p) => !(patch.products ?? []).includes(p)))) {
        const templates = await tx.documentTemplate.count({ where: { document_type_id: id } });
        if (templates > 0) {
          if (changed.includes('template_kind')) throw new DocumentTypeConflictError(id, 'kind_in_use', { templates });
          throw new DocumentTypeConflictError(id, 'product_in_use', {
            templates,
            removed: t.products.filter((p) => !(patch.products ?? []).includes(p)),
          });
        }
      }
      if (beforeWrite !== undefined) await beforeWrite({ type: t, changed_fields: changed });
      const type = await tx.documentType.update({
        where: { id },
        data: {
          ...(changed.includes('name') ? { name: patch.name } : {}),
          ...(changed.includes('description') ? { description: patch.description } : {}),
          ...(changed.includes('category') ? { category: patch.category } : {}),
          ...(changed.includes('template_kind') ? { template_kind: patch.template_kind } : {}),
          ...(changed.includes('products') ? { products: patch.products } : {}),
          ...(changed.includes('retention_class') ? { retention_class: patch.retention_class } : {}),
          ...(changed.includes('execution_mode_default') ? { execution_mode_default: patch.execution_mode_default } : {}),
        },
      });
      return { type, changed_fields: changed };
    });
  }

  // POST :id/retire — active = false. Refused for a system-locked or UPLOAD type and while an
  // Aramo default of the type is live (ACTIVE, no withdrawal published). Retiring a retired
  // type is a no-op (no audit).
  async retire(id: string, beforeWrite?: Hook<{ type: PlatformDocumentTypeRow }>): Promise<PlatformDocumentTypeRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const t = await tx.documentType.findFirstOrThrow({ where: { id } });
      if (!t.active) return t;
      if (isSystemLockedType(id)) throw new DocumentTypeConflictError(id, 'system_locked');
      if (t.type_class === 'UPLOAD') throw new DocumentTypeConflictError(id, 'upload_type');
      const live = await tx.documentTemplate.findFirst({
        where: { owner_scope: 'PLATFORM', tenant_id: null, document_type_id: id, status: 'ACTIVE', withdraw_effective_at: null },
        select: { id: true },
      });
      if (live !== null) throw new DocumentTypeConflictError(id, 'live_default', { live_template_id: live.id });
      if (beforeWrite !== undefined) await beforeWrite({ type: t });
      return tx.documentType.update({ where: { id }, data: { active: false } });
    });
  }

  // DELETE :id — only a type created in Platform Admin (system_defined false) that nothing
  // references: no template of any owner (§4.3), and — because the foreign keys RESTRICT —
  // no Document, requirement or selection either.
  async delete(id: string, beforeWrite?: Hook<{ type: PlatformDocumentTypeRow }>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, id);
      const t = await tx.documentType.findFirstOrThrow({ where: { id } });
      if (isSystemLockedType(id)) throw new DocumentTypeConflictError(id, 'system_locked');
      if (t.system_defined) throw new DocumentTypeConflictError(id, 'seeded');
      const templates = await tx.documentTemplate.count({ where: { document_type_id: id } });
      const documents = await tx.document.count({ where: { document_type_id: id } });
      const requirements = await tx.documentRequirement.count({ where: { document_type_id: id } });
      const selections = await tx.tenantTemplateSelection.count({ where: { document_type_id: id } });
      if (templates + documents + requirements + selections > 0) {
        throw new DocumentTypeConflictError(id, 'in_use', { templates, documents, requirements, selections });
      }
      if (beforeWrite !== undefined) await beforeWrite({ type: t });
      await tx.documentType.delete({ where: { id } });
    });
  }

  private async lock(tx: { $queryRaw: PrismaService['$queryRaw'] }, id: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text FROM "documents"."DocumentType" WHERE "id" = ${id}::uuid AND "tenant_id" IS NULL FOR UPDATE`;
    if (rows.length === 0) throw new DocumentTypeNotFoundError(id);
  }
}

// Prisma 7 + PrismaPg surfaces the raw index name at meta.driverAdapterError.cause.originalMessage.
function driverMessage(e: unknown): string {
  const original = (e as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } } })?.meta?.driverAdapterError?.cause?.originalMessage;
  return `${typeof original === 'string' ? original : ''} ${e instanceof Error ? e.message : ''}`;
}
