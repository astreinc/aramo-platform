import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  DocumentNotFoundError,
  TemplateDraftAlreadyExistsError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplatePreviewRequiredError,
  TemplateVersionNotFoundError,
} from './domain/errors.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§18) — deterministic fingerprint of a version's editable
// content (field_schema), used for the preview-revision gate. Canonical (key-sorted)
// stringify so semantically-identical content hashes identically regardless of key
// order returned by the driver.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
function templateContentFingerprint(field_schema: unknown): string {
  return createHash('sha256').update(stableStringify(field_schema ?? null)).digest('hex');
}

// §41 race backstop — map a Postgres unique-violation on the one-DRAFT partial index
// to the typed TEMPLATE_DRAFT_ALREADY_EXISTS. Prisma 7 + PrismaPg surfaces the raw
// index name at meta.driverAdapterError.cause.originalMessage (NOT meta.target).
function mapOneDraftConflict(e: unknown, templateId: string): unknown {
  const originalMessage = (e as {
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
  })?.meta?.driverAdapterError?.cause?.originalMessage;
  if (typeof originalMessage === 'string' && originalMessage.includes('TemplateVersion_one_draft_per_template')) {
    return new TemplateDraftAlreadyExistsError(templateId, 'concurrent');
  }
  return e;
}

// DOC-2 boundary 4 — DocumentTemplate + TemplateVersion + TemplateFieldDefinition
// + TemplateAsset + DocumentPacket. A TemplateVersion is immutable once ACTIVE
// (app-surface guard here; the DB trigger from the migration is the backstop).
// Editing an ACTIVE version is rejected — a change makes a NEW version.

export interface CreateTemplateInput {
  tenant_id: string;
  document_type_id: string;
  name: string;
  description?: string;
  template_kind: string;
  client_id?: string;
  created_by: string;
}

export interface CreateVersionInput {
  tenant_id: string;
  template_id: string;
  render_schema_version: string;
  field_schema?: unknown;
  binding_schema?: unknown;
  source_artifact_id?: string;
  effective_from?: Date;
  created_by: string;
}

export interface AddFieldInput {
  tenant_id: string;
  template_version_id: string;
  field_key: string;
  field_type: string;
  binding_key?: string;
  required?: boolean;
  page_number?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  format_rule?: string;
  signer_role?: string;
  ordinal: number;
}

@Injectable()
export class TemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Templates ──────────────────────────────────────────────────────────────
  async createTemplate(input: CreateTemplateInput) {
    return this.prisma.documentTemplate.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        document_type_id: input.document_type_id,
        client_id: input.client_id ?? null,
        name: input.name,
        description: input.description ?? null,
        template_kind: input.template_kind,
        status: 'DRAFT',
        created_by: input.created_by,
      },
    });
  }

  async listTemplates(tenant_id: string) {
    return this.prisma.documentTemplate.findMany({ where: { tenant_id }, orderBy: { created_at: 'desc' } });
  }

  async getTemplate(tenant_id: string, id: string) {
    const t = await this.prisma.documentTemplate.findFirst({ where: { tenant_id, id } });
    if (t === null) throw new TemplateNotFoundError(id);
    return t;
  }

  // RTR-TEMPLATE-1 (§6) — the tenant-wide ACTIVE template for a DocumentType
  // (client_id IS NULL; client-scoped precedence is out of scope this slice).
  // Generic + workflow-neutral: returns the row or null. Resolution/validation of
  // current_version_id -> ACTIVE version is the caller's concern (apps/api). There
  // is NO single-ACTIVE DB constraint, so callers must use current_version_id as
  // the authority, never "first ACTIVE row wins."
  async findActiveTenantTemplateForType(tenant_id: string, document_type_id: string) {
    return this.prisma.documentTemplate.findFirst({
      where: { tenant_id, document_type_id, client_id: null, status: 'ACTIVE' },
    });
  }

  // RTR-TEMPLATE-1 (§13) — nullable template read for provenance resolution from
  // a PINNED version's template_id (does not throw; never consults current_version_id).
  async findTemplateById(tenant_id: string, id: string) {
    return this.prisma.documentTemplate.findFirst({ where: { tenant_id, id } });
  }

  // ── Versions ─────────────────────────────────────────────────────────────
  async createVersion(input: CreateVersionInput) {
    await this.getTemplate(input.tenant_id, input.template_id);
    // §41 one-DRAFT invariant — app-surface guard: if an open DRAFT already exists,
    // refuse (return/navigate to it at the caller). The partial unique index is the
    // concurrent-race backstop (mapOneDraftConflict below).
    const existingDraft = await this.prisma.templateVersion.findFirst({
      where: { tenant_id: input.tenant_id, template_id: input.template_id, status: 'DRAFT' },
    });
    if (existingDraft !== null) throw new TemplateDraftAlreadyExistsError(input.template_id, existingDraft.id);
    // Next version_number = max + 1 (unique tuple (template_id, version_number)).
    const last = await this.prisma.templateVersion.findFirst({
      where: { tenant_id: input.tenant_id, template_id: input.template_id },
      orderBy: { version_number: 'desc' },
    });
    const nextNumber = (last?.version_number ?? 0) + 1;
    try {
      return await this.prisma.templateVersion.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          template_id: input.template_id,
          version_number: nextNumber,
          status: 'DRAFT',
          render_schema_version: input.render_schema_version,
          field_schema: (input.field_schema ?? undefined) as never,
          binding_schema: (input.binding_schema ?? undefined) as never,
          source_artifact_id: input.source_artifact_id ?? null,
          effective_from: input.effective_from ?? null,
          created_by: input.created_by,
          // §18 — fingerprint the starting content so the preview gate is armed on create.
          content_fingerprint: templateContentFingerprint(input.field_schema ?? null),
        },
      });
    } catch (e) {
      throw mapOneDraftConflict(e, input.template_id);
    }
  }

  // DOC-TEMPLATE-ADMIN-RTR-1 (§8) — create a DRAFT vN+1 by COPYING the template's
  // current ACTIVE version's editable content as the starting point. One-DRAFT guarded;
  // never touches current_version_id or any workflow. Returns the existing DRAFT's id
  // via TemplateDraftAlreadyExistsError if one is already open.
  async createDraftFromActive(input: { tenant_id: string; template_id: string; created_by: string }) {
    const template = await this.getTemplate(input.tenant_id, input.template_id);
    const active =
      template.current_version_id !== null
        ? await this.prisma.templateVersion.findFirst({
            where: { tenant_id: input.tenant_id, id: template.current_version_id },
          })
        : null;
    return this.createVersion({
      tenant_id: input.tenant_id,
      template_id: input.template_id,
      render_schema_version: active?.render_schema_version ?? 'rtr-generated-v1',
      field_schema: active?.field_schema ?? undefined,
      created_by: input.created_by,
    });
  }

  // §9 — update a DRAFT version's editable content. DRAFT-ONLY (ACTIVE/RETIRED →
  // TemplateImmutableError). Recomputes content_fingerprint and CLEARS
  // previewed_fingerprint so the §18 preview gate re-arms (editing invalidates a prior
  // preview). Never mutates version_number/status/tenant_id/template_id/created_by/
  // activated_*/retired_*.
  async updateDraftVersion(input: {
    tenant_id: string;
    version_id: string;
    field_schema: unknown;
    render_schema_version?: string;
  }) {
    const v = await this.getVersion(input.tenant_id, input.version_id);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    return this.prisma.templateVersion.update({
      where: { id: input.version_id },
      data: {
        field_schema: (input.field_schema ?? undefined) as never,
        ...(input.render_schema_version !== undefined
          ? { render_schema_version: input.render_schema_version }
          : {}),
        content_fingerprint: templateContentFingerprint(input.field_schema ?? null),
        previewed_fingerprint: null, // re-arm the preview gate on any content edit
      },
    });
  }

  // §18 — record that the CURRENT draft content has been previewed:
  // previewed_fingerprint := content_fingerprint. Deterministic + durable (not FE
  // state). DRAFT-only (admin preview-before-approval targets a DRAFT).
  async recordPreview(input: { tenant_id: string; version_id: string }) {
    const v = await this.getVersion(input.tenant_id, input.version_id);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    const fp = v.content_fingerprint ?? templateContentFingerprint(v.field_schema ?? null);
    return this.prisma.templateVersion.update({
      where: { id: input.version_id },
      data: { content_fingerprint: fp, previewed_fingerprint: fp },
    });
  }

  async listVersions(tenant_id: string, template_id: string) {
    await this.getTemplate(tenant_id, template_id);
    return this.prisma.templateVersion.findMany({
      where: { tenant_id, template_id },
      orderBy: { version_number: 'asc' },
    });
  }

  async getVersion(tenant_id: string, id: string) {
    const v = await this.prisma.templateVersion.findFirst({ where: { tenant_id, id } });
    if (v === null) throw new TemplateVersionNotFoundError(id);
    return v;
  }

  // RTR-TEMPLATE-1 (§27) — nullable version read for resolution validation. Unlike
  // getVersion this does NOT throw; the resolver maps absence/invalid state to its
  // own typed configuration refusal rather than leaking a lib-local error.
  async findVersionById(tenant_id: string, id: string) {
    return this.prisma.templateVersion.findFirst({ where: { tenant_id, id } });
  }

  // DRAFT -> ACTIVE. Idempotent if already ACTIVE. Sets the template's
  // current_version_id and retires any prior ACTIVE version of the same template
  // (a template has at most one ACTIVE version). Immutability begins here.
  // DRAFT -> ACTIVE. §18 preview gate + §21 actor provenance. `require_preview`
  // defaults TRUE (the admin Approve & activate path): the CURRENT draft content must
  // have been previewed (content_fingerprint == previewed_fingerprint), else
  // TemplatePreviewRequiredError — backend-authoritative, never FE-only. Trusted
  // bootstrap/provisioning (the default-RTR seed) passes require_preview:false.
  async activateVersion(input: {
    tenant_id: string;
    version_id: string;
    actor_id: string;
    require_preview?: boolean;
  }) {
    const v = await this.getVersion(input.tenant_id, input.version_id);
    if (v.status === 'ACTIVE') return v; // no-op
    if (v.status === 'RETIRED') throw new TemplateImmutableError(input.version_id);
    if (input.require_preview !== false) {
      const currentFp = v.content_fingerprint ?? templateContentFingerprint(v.field_schema ?? null);
      if (v.previewed_fingerprint === null || v.previewed_fingerprint !== currentFp) {
        throw new TemplatePreviewRequiredError(input.version_id);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      // Retire the current ACTIVE version of this template, if any.
      await tx.templateVersion.updateMany({
        where: { tenant_id: input.tenant_id, template_id: v.template_id, status: 'ACTIVE' },
        data: { status: 'RETIRED', retired_at: new Date() },
      });
      await tx.templateVersion.update({
        where: { id: input.version_id },
        data: { status: 'ACTIVE', activated_at: new Date(), activated_by: input.actor_id },
      });
      await tx.documentTemplate.update({
        where: { id: v.template_id },
        data: { status: 'ACTIVE', current_version_id: input.version_id },
      });
      return tx.templateVersion.findFirstOrThrow({ where: { id: input.version_id } });
    });
  }

  // ── Fields (canonical field model, NOT AcroForm) ─────────────────────────
  async addField(input: AddFieldInput) {
    const v = await this.getVersion(input.tenant_id, input.template_version_id);
    // A field is content: it cannot be added once the version is ACTIVE.
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.template_version_id);
    return this.prisma.templateFieldDefinition.create({
      data: {
        id: randomUUID(),
        template_version_id: input.template_version_id,
        field_key: input.field_key,
        field_type: input.field_type,
        binding_key: input.binding_key ?? null,
        required: input.required ?? false,
        page_number: input.page_number ?? null,
        x: input.x ?? null,
        y: input.y ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        format_rule: input.format_rule ?? null,
        signer_role: input.signer_role ?? null,
        ordinal: input.ordinal,
      },
    });
  }

  async listFields(tenant_id: string, template_version_id: string) {
    await this.getVersion(tenant_id, template_version_id);
    return this.prisma.templateFieldDefinition.findMany({
      where: { template_version_id },
      orderBy: { ordinal: 'asc' },
    });
  }

  // ── Assets (content-hashed render inputs) ─────────────────────────────────
  async createAsset(input: {
    tenant_id: string;
    asset_kind: string;
    sha256: string;
    mime_type: string;
    storage_provider: string;
    storage_locator: string;
    name: string;
    created_by: string;
  }) {
    return this.prisma.templateAsset.create({ data: { id: randomUUID(), ...input } });
  }

  // ── Packets (generic grouping; does NOT own document business state) ──────
  async createPacket(input: {
    tenant_id: string;
    packet_type: string;
    title: string;
    created_by: string;
  }) {
    return this.prisma.documentPacket.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        packet_type: input.packet_type,
        title: input.title,
        status: 'OPEN',
        created_by: input.created_by,
      },
    });
  }

  async addPacketItem(input: {
    tenant_id: string;
    packet_id: string;
    document_id: string;
    sequence: number;
    required?: boolean;
  }) {
    // Tenant-scoped existence checks (cross-tenant packet/document => NOT FOUND).
    const packet = await this.prisma.documentPacket.findFirst({
      where: { tenant_id: input.tenant_id, id: input.packet_id },
    });
    if (packet === null) throw new TemplateNotFoundError(input.packet_id);
    const doc = await this.prisma.document.findFirst({
      where: { tenant_id: input.tenant_id, id: input.document_id },
    });
    if (doc === null) throw new DocumentNotFoundError(input.document_id);
    return this.prisma.documentPacketItem.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        packet_id: input.packet_id,
        document_id: input.document_id,
        sequence: input.sequence,
        required: input.required ?? true,
      },
    });
  }

  async listPackets(tenant_id: string) {
    return this.prisma.documentPacket.findMany({
      where: { tenant_id },
      orderBy: { created_at: 'desc' },
      include: { items: { orderBy: { sequence: 'asc' } } },
    });
  }

  async getPacket(tenant_id: string, id: string) {
    const p = await this.prisma.documentPacket.findFirst({
      where: { tenant_id, id },
      include: { items: { orderBy: { sequence: 'asc' } } },
    });
    if (p === null) throw new TemplateNotFoundError(id);
    return p;
  }
}
