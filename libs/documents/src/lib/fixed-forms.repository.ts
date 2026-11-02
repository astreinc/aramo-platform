import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { FIXED_FORM_SCHEMA_V1, type FixedFormField } from './fixed-forms.js';
import { templateContentFingerprint } from './templates.repository.js';
import {
  DocumentNotFoundError,
  TemplateDraftAlreadyExistsError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
} from './domain/errors.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — the persistence of fixed
// legal forms, kept apart from TemplatesRepository (new file; the shared template code paths
// are unchanged):
//   §7.1 PlatformTemplateAsset — the official PDF of a DRAFT PLATFORM version;
//   §7.2 the placed fields (TemplateFieldDefinition) of a PLATFORM fixed-form DRAFT, written
//        with the same content fingerprint as every template, so any change re-arms the §18
//        preview gate (publish = the shared activatePlatformVersion);
//   §7.3 the published fixed forms a tenant sees and its Hide / Show choice
//        (TenantTemplateVisibility, default shown);
//   §7.4 the frozen DocumentRevision of a Sign envelope started from a fixed form, pinned to
//        the exact version (T-5 rule), written like RenderService writes a rendered one.
// Every PLATFORM read names owner_scope explicitly (never "tenant_id IS NULL matches").

export interface FixedFormTypeRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly products: readonly string[];
  readonly category: string | null;
}

export interface PublishedFixedForm {
  readonly template: {
    id: string;
    document_type_id: string;
    name: string;
    description: string | null;
    products: string[];
    current_version_id: string;
    withdraw_effective_at: Date | null;
    updated_at: Date;
  };
  readonly version: { id: string; version_number: number; activated_at: Date | null; field_schema: unknown };
  readonly type: FixedFormTypeRow;
}

type FieldRow = Omit<FixedFormField, 'ordinal'> & { ordinal: number };

const PLATFORM_TEMPLATE = { owner_scope: 'PLATFORM', tenant_id: null } as const;

function mapOneDraftConflict(e: unknown, templateId: string): unknown {
  const original = (e as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } } })?.meta?.driverAdapterError?.cause?.originalMessage;
  const message = e instanceof Error ? e.message : '';
  if ((typeof original === 'string' && original.includes('TemplateVersion_one_draft_per_template')) || message.includes('TemplateVersion_one_draft_per_template')) {
    return new TemplateDraftAlreadyExistsError(templateId, 'concurrent');
  }
  return e;
}

@Injectable()
export class FixedFormsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Document types ──────────────────────────────────────────────────────────

  /** The active SYSTEM TEMPLATE types of kind FIXED_FORM, optionally tagged with a product. */
  async listFixedFormTypes(product?: string): Promise<FixedFormTypeRow[]> {
    const rows = await this.prisma.documentType.findMany({
      where: {
        tenant_id: null,
        active: true,
        type_class: 'TEMPLATE',
        template_kind: 'FIXED_FORM',
        ...(product !== undefined ? { products: { has: product } } : {}),
      },
      orderBy: { key: 'asc' },
    });
    return rows.map((t) => ({ id: t.id, key: t.key, name: t.name, products: t.products, category: t.category }));
  }

  /** Whether a document type is a FIXED_FORM type (any active state; null when unknown). */
  async isFixedFormType(document_type_id: string): Promise<boolean> {
    const t = await this.prisma.documentType.findFirst({ where: { id: document_type_id }, select: { template_kind: true, type_class: true } });
    return t !== null && t.type_class === 'TEMPLATE' && t.template_kind === 'FIXED_FORM';
  }

  // ── Platform authoring (§7.1, §7.2) ─────────────────────────────────────────

  async getPlatformTemplate(id: string) {
    const t = await this.prisma.documentTemplate.findFirst({ where: { id, ...PLATFORM_TEMPLATE } });
    if (t === null) throw new TemplateNotFoundError(id);
    return t;
  }

  /** A PLATFORM version and its template (TemplateVersionNotFoundError when not PLATFORM). */
  async getPlatformVersion(version_id: string) {
    const version = await this.prisma.templateVersion.findFirst({
      where: { id: version_id, tenant_id: null, template: { owner_scope: 'PLATFORM' } },
      include: { template: true },
    });
    if (version === null) throw new TemplateVersionNotFoundError(version_id);
    const { template, ...v } = version;
    return { version: v, template };
  }

  async createPlatformAsset(input: {
    template_version_id: string;
    storage_key: string;
    sha256: string;
    byte_size: number;
    page_count: number;
    created_by: string;
  }) {
    return this.prisma.platformTemplateAsset.create({
      data: { id: randomUUID(), mime: 'application/pdf', ...input },
    });
  }

  async findPlatformAsset(id: string) {
    return this.prisma.platformTemplateAsset.findFirst({ where: { id } });
  }

  /** The asset ids uploaded to any version of a template (a draft may keep a prior version's PDF). */
  async templateOwnsAsset(template_id: string, asset_id: string): Promise<boolean> {
    const asset = await this.findPlatformAsset(asset_id);
    if (asset === null) return false;
    const v = await this.prisma.templateVersion.findFirst({ where: { id: asset.template_version_id, template_id }, select: { id: true } });
    return v !== null;
  }

  async listFields(version_id: string) {
    return this.prisma.templateFieldDefinition.findMany({ where: { template_version_id: version_id }, orderBy: { ordinal: 'asc' } });
  }

  /**
   * A new DRAFT of a PLATFORM fixed form: the current version's content and placed fields
   * (a new issuer edition replaces the PDF on the draft), or `initial` for the first version.
   * One DRAFT per template (TemplateDraftAlreadyExistsError, the partial index is the backstop).
   */
  async createPlatformDraft(input: { template_id: string; created_by: string; initial: unknown }) {
    const template = await this.getPlatformTemplate(input.template_id);
    const existing = await this.prisma.templateVersion.findFirst({ where: { tenant_id: null, template_id: template.id, status: 'DRAFT' } });
    if (existing !== null) throw new TemplateDraftAlreadyExistsError(template.id, existing.id);
    const current =
      template.current_version_id === null
        ? null
        : await this.prisma.templateVersion.findFirst({ where: { id: template.current_version_id, tenant_id: null }, include: { fields: true } });
    const field_schema = current !== null && current.render_schema_version === FIXED_FORM_SCHEMA_V1 ? current.field_schema : input.initial;
    const fields = current !== null && current.render_schema_version === FIXED_FORM_SCHEMA_V1 ? current.fields : [];
    const last = await this.prisma.templateVersion.findFirst({ where: { tenant_id: null, template_id: template.id }, orderBy: { version_number: 'desc' } });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const draft = await tx.templateVersion.create({
          data: {
            id: randomUUID(),
            tenant_id: null,
            template_id: template.id,
            version_number: (last?.version_number ?? 0) + 1,
            status: 'DRAFT',
            render_schema_version: FIXED_FORM_SCHEMA_V1,
            field_schema: JSON.parse(JSON.stringify(field_schema ?? null)) as never,
            internal_notes: current?.internal_notes ?? null,
            created_by: input.created_by,
            content_fingerprint: templateContentFingerprint(field_schema ?? null, fields),
          },
        });
        for (const f of fields) {
          await tx.templateFieldDefinition.create({
            data: {
              id: randomUUID(),
              template_version_id: draft.id,
              field_key: f.field_key,
              field_type: f.field_type,
              binding_key: f.binding_key,
              required: f.required,
              page_number: f.page_number,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              format_rule: f.format_rule,
              signer_role: f.signer_role,
              ordinal: f.ordinal,
            },
          });
        }
        return draft;
      });
    } catch (e) {
      throw mapOneDraftConflict(e, template.id);
    }
  }

  /**
   * Replace a PLATFORM DRAFT's content and/or its placed fields in one transaction. The
   * fingerprint is recomputed and the preview is cleared (the §18 gate re-arms).
   */
  async writePlatformDraft(input: { version_id: string; field_schema?: unknown; fields?: readonly FieldRow[] }) {
    const { version } = await this.getPlatformVersion(input.version_id);
    if (version.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    return this.prisma.$transaction(async (tx) => {
      if (input.fields !== undefined) {
        await tx.templateFieldDefinition.deleteMany({ where: { template_version_id: version.id } });
        for (const f of input.fields) {
          await tx.templateFieldDefinition.create({ data: { id: randomUUID(), template_version_id: version.id, format_rule: null, ...f } });
        }
      }
      const field_schema = input.field_schema !== undefined ? input.field_schema : version.field_schema;
      const fields = await tx.templateFieldDefinition.findMany({ where: { template_version_id: version.id }, orderBy: { ordinal: 'asc' } });
      const fp = templateContentFingerprint(field_schema ?? null, fields);
      const updated = await tx.templateVersion.updateMany({
        where: { id: version.id, status: 'DRAFT' },
        data: {
          ...(input.field_schema !== undefined
            ? { field_schema: JSON.parse(JSON.stringify(input.field_schema ?? null)) as never, render_schema_version: FIXED_FORM_SCHEMA_V1 }
            : {}),
          content_fingerprint: fp,
          previewed_fingerprint: null,
        },
      });
      if (updated.count === 0) throw new TemplateImmutableError(input.version_id);
      return tx.templateVersion.findFirstOrThrow({ where: { id: version.id } });
    });
  }

  /** Add one placed field to a PLATFORM DRAFT (mirrors the tenant POST versions/:id/fields). */
  async addPlatformDraftField(input: { version_id: string; field: FieldRow }) {
    const { version } = await this.getPlatformVersion(input.version_id);
    if (version.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    const created = await this.prisma.templateFieldDefinition.create({
      data: { id: randomUUID(), template_version_id: version.id, format_rule: null, ...input.field },
    });
    const fields = await this.listFields(version.id);
    await this.prisma.templateVersion.update({
      where: { id: version.id },
      data: { content_fingerprint: templateContentFingerprint(version.field_schema ?? null, fields), previewed_fingerprint: null },
    });
    return created;
  }

  // ── Tenant (§7.3) ───────────────────────────────────────────────────────────

  /**
   * The published Aramo fixed forms: PLATFORM, ACTIVE, pinned to an ACTIVE current version,
   * withdrawal not yet effective, of an active FIXED_FORM type — optionally only those tagged
   * with one of `products` (a tenant sees a form tagged with a product it is entitled to).
   */
  async listPublishedFixedForms(input: { now: Date; products?: readonly string[]; template_id?: string }): Promise<PublishedFixedForm[]> {
    const types = await this.listFixedFormTypes();
    if (types.length === 0) return [];
    const byType = new Map(types.map((t) => [t.id, t]));
    const rows = await this.prisma.documentTemplate.findMany({
      where: {
        ...PLATFORM_TEMPLATE,
        ...(input.template_id !== undefined ? { id: input.template_id } : {}),
        document_type_id: { in: [...byType.keys()] },
        status: 'ACTIVE',
        current_version_id: { not: null },
        OR: [{ withdraw_effective_at: null }, { withdraw_effective_at: { gt: input.now } }],
        ...(input.products !== undefined ? { products: { hasSome: [...input.products] } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const versionIds = rows.map((r) => r.current_version_id).filter((id): id is string => id !== null);
    const versions = await this.prisma.templateVersion.findMany({
      where: { id: { in: versionIds }, tenant_id: null, status: 'ACTIVE', render_schema_version: FIXED_FORM_SCHEMA_V1 },
      select: { id: true, template_id: true, version_number: true, activated_at: true, field_schema: true },
    });
    const vById = new Map(versions.map((v) => [v.id, v]));
    const out: PublishedFixedForm[] = [];
    for (const r of rows) {
      const v = r.current_version_id === null ? undefined : vById.get(r.current_version_id);
      const type = byType.get(r.document_type_id);
      if (v === undefined || v.template_id !== r.id || type === undefined) continue;
      out.push({
        template: {
          id: r.id,
          document_type_id: r.document_type_id,
          name: r.name,
          description: r.description,
          products: r.products ?? [],
          current_version_id: v.id,
          withdraw_effective_at: r.withdraw_effective_at,
          updated_at: r.updated_at,
        },
        version: { id: v.id, version_number: v.version_number, activated_at: v.activated_at, field_schema: v.field_schema },
        type,
      });
    }
    return out;
  }

  /** The tenant's Hide / Show rows (template_id → hidden). No row = shown. */
  async visibilityFor(tenant_id: string): Promise<Map<string, boolean>> {
    const rows = await this.prisma.tenantTemplateVisibility.findMany({ where: { tenant_id } });
    return new Map(rows.map((r) => [r.template_id, r.hidden]));
  }

  /** Set the tenant's choice. Returns the previous hidden state (false when there was no row). */
  async setVisibility(input: { tenant_id: string; template_id: string; hidden: boolean; updated_by: string }): Promise<boolean> {
    const prior = await this.prisma.tenantTemplateVisibility.findFirst({ where: { tenant_id: input.tenant_id, template_id: input.template_id } });
    await this.prisma.tenantTemplateVisibility.upsert({
      where: { tenant_id_template_id: { tenant_id: input.tenant_id, template_id: input.template_id } },
      create: { tenant_id: input.tenant_id, template_id: input.template_id, hidden: input.hidden, updated_by: input.updated_by, updated_at: new Date() },
      update: { hidden: input.hidden, updated_by: input.updated_by, updated_at: new Date() },
    });
    return prior?.hidden ?? false;
  }

  // ── Sign (§7.4) ─────────────────────────────────────────────────────────────

  /**
   * Freeze the stored PDF (with any prefilled values printed) as the Document's FROZEN
   * revision + RENDERED_UNSIGNED artifact, pinned to the exact template version. The bytes
   * are already stored (storage_key) — one transaction, like RenderService.generateRevision.
   */
  async writeFrozenRevision(input: {
    tenant_id: string;
    document_id: string;
    template_version_id: string;
    storage_key: string;
    sha256: string;
    byte_size: number;
    render_manifest: unknown;
    actor_id: string;
  }) {
    const doc = await this.prisma.document.findFirst({ where: { tenant_id: input.tenant_id, id: input.document_id } });
    if (doc === null) throw new DocumentNotFoundError(input.document_id);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.documentRevision.findFirst({
        where: { tenant_id: input.tenant_id, document_id: input.document_id },
        orderBy: { revision_number: 'desc' },
      });
      const revisionId = randomUUID();
      await tx.documentRevision.create({
        data: {
          id: revisionId,
          tenant_id: input.tenant_id,
          document_id: input.document_id,
          revision_number: (last?.revision_number ?? 0) + 1,
          template_version_id: input.template_version_id,
          render_manifest: JSON.parse(JSON.stringify(input.render_manifest ?? null)) as never,
          content_sha256: input.sha256,
          mime_type: 'application/pdf',
          byte_size: input.byte_size,
          status: 'FROZEN',
          created_by: input.actor_id,
          frozen_at: new Date(),
        },
      });
      await tx.documentArtifact.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          revision_id: revisionId,
          document_id: input.document_id,
          artifact_role: 'RENDERED_UNSIGNED',
          storage_provider: 'aramo-s3',
          storage_locator: input.storage_key,
          mime_type: 'application/pdf',
          byte_size: input.byte_size,
          sha256: input.sha256,
          immutability_state: 'FROZEN',
          retention_class: 'DOCUMENT_RENDER',
          created_by: input.actor_id,
        },
      });
      return { revision_id: revisionId };
    });
  }
}
