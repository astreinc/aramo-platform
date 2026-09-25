import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  DocumentNotFoundError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
} from './domain/errors.js';

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

  // ── Versions ─────────────────────────────────────────────────────────────
  async createVersion(input: CreateVersionInput) {
    await this.getTemplate(input.tenant_id, input.template_id);
    // Next version_number = max + 1 (unique tuple (template_id, version_number)).
    const last = await this.prisma.templateVersion.findFirst({
      where: { tenant_id: input.tenant_id, template_id: input.template_id },
      orderBy: { version_number: 'desc' },
    });
    const nextNumber = (last?.version_number ?? 0) + 1;
    return this.prisma.templateVersion.create({
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
      },
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

  // DRAFT -> ACTIVE. Idempotent if already ACTIVE. Sets the template's
  // current_version_id and retires any prior ACTIVE version of the same template
  // (a template has at most one ACTIVE version). Immutability begins here.
  async activateVersion(input: { tenant_id: string; version_id: string; actor_id: string }) {
    const v = await this.getVersion(input.tenant_id, input.version_id);
    if (v.status === 'ACTIVE') return v; // no-op
    if (v.status === 'RETIRED') throw new TemplateImmutableError(input.version_id);
    return this.prisma.$transaction(async (tx) => {
      // Retire the current ACTIVE version of this template, if any.
      await tx.templateVersion.updateMany({
        where: { tenant_id: input.tenant_id, template_id: v.template_id, status: 'ACTIVE' },
        data: { status: 'RETIRED', retired_at: new Date() },
      });
      await tx.templateVersion.update({
        where: { id: input.version_id },
        data: { status: 'ACTIVE', activated_at: new Date() },
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
