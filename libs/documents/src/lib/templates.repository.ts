import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  DocumentNotFoundError,
  TemplateDraftAlreadyExistsError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplatePlatformDefaultConflictError,
  TemplatePreviewRequiredError,
  TemplateSelectionInvalidError,
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
// M-A6 (LOCKED) §3.4 — field definitions JOIN the fingerprint: adding, changing or
// removing a TemplateFieldDefinition re-arms the preview gate like a content edit. A
// version with NO field definitions hashes exactly as before (field_schema only), so
// every existing rtr-generated-v1 / rtr-html-v1 fingerprint is unchanged.
interface FingerprintField {
  field_key: string;
  field_type: string;
  binding_key: string | null;
  required: boolean;
  page_number: number | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  format_rule: string | null;
  signer_role: string | null;
  ordinal: number;
}
function templateContentFingerprint(field_schema: unknown, fields: readonly FingerprintField[] = []): string {
  if (fields.length === 0) return createHash('sha256').update(stableStringify(field_schema ?? null)).digest('hex');
  const field_definitions = [...fields]
    .sort((a, b) => a.ordinal - b.ordinal || (a.field_key < b.field_key ? -1 : a.field_key > b.field_key ? 1 : 0))
    .map((f) => ({
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
    }));
  return createHash('sha256').update(stableStringify({ field_schema: field_schema ?? null, field_definitions })).digest('hex');
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

// DOC-TEMPLATE-LIB-1 T-6 — map a unique-violation on the one-live-default partial index
// (migration 20261021160000) to the typed 409 platform_default_live. Same driver-message
// probe as the one-DRAFT backstop above.
function mapOneLiveDefaultConflict(e: unknown, templateId: string): unknown {
  const originalMessage = (e as {
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
  })?.meta?.driverAdapterError?.cause?.originalMessage;
  const message = e instanceof Error ? e.message : '';
  if (
    (typeof originalMessage === 'string' && originalMessage.includes('DocumentTemplate_one_live_platform_default')) ||
    message.includes('DocumentTemplate_one_live_platform_default')
  ) {
    return new TemplatePlatformDefaultConflictError(templateId, 'platform_default_live');
  }
  return e;
}

const DAY_MS = 86_400_000;

// DOC-TEMPLATE-LIB-1 T-2 (§6.1, ADR-0034 §4 rule 2) — the OWNER a template write/read is
// scoped to. TENANT = the caller's own rows (every tenant route; tenant_id equality, so
// a PLATFORM row — tenant_id NULL — can never match). PLATFORM = the Aramo defaults,
// reached ONLY through the platform* methods below, which only the platform-tier
// controller (apps/api, consumer_type=platform + platform:document_template:*) calls.
// The DRAFT / preview-gate / activate logic is shared by both owners (one code path).
type TemplateOwner = { readonly kind: 'TENANT'; readonly tenant_id: string } | { readonly kind: 'PLATFORM' };
const PLATFORM_OWNER: TemplateOwner = { kind: 'PLATFORM' };
const tenantOwner = (tenant_id: string): TemplateOwner => ({ kind: 'TENANT', tenant_id });
// The tenant_id value carried by the owner's rows (NULL for PLATFORM — DB CHECK).
const ownerTenantId = (o: TemplateOwner): string | null => (o.kind === 'TENANT' ? o.tenant_id : null);
// DocumentTemplate filter for the owner. The PLATFORM arm names owner_scope explicitly
// (never "tenant_id IS NULL matches").
const templateWhere = (o: TemplateOwner) =>
  o.kind === 'TENANT' ? { tenant_id: o.tenant_id } : { owner_scope: 'PLATFORM', tenant_id: null };
// TemplateVersion filter for the owner (a PLATFORM version: tenant_id NULL + PLATFORM parent).
const versionWhere = (o: TemplateOwner) =>
  o.kind === 'TENANT' ? { tenant_id: o.tenant_id } : { tenant_id: null, template: { owner_scope: 'PLATFORM' } };

export interface CreatePlatformTemplateInput {
  document_type_id: string;
  name: string;
  description?: string;
  template_kind: string;
  products: string[];
  created_by: string;
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
  // Slice 1 B1 — admin-only notes (≤500; never rendered). Caller validates.
  internal_notes?: string | null;
  created_by: string;
}

type DraftTransform = (c: { render_schema_version: string; field_schema: unknown }) => {
  render_schema_version: string;
  field_schema: unknown;
};

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
    return this.getTemplateFor(tenantOwner(tenant_id), id);
  }

  private async getTemplateFor(owner: TemplateOwner, id: string) {
    const t = await this.prisma.documentTemplate.findFirst({ where: { ...templateWhere(owner), id } });
    if (t === null) throw new TemplateNotFoundError(id);
    return t;
  }

  // Document Templates slice 1 (PO ruling 2, 2026-10-16) — the template NAME is saved
  // on the TEMPLATE (DocumentTemplate.name), not per version. Tenant-scoped: an unknown
  // or cross-tenant id is TemplateNotFoundError (404 concealment). Touches only `name`
  // (never status/current_version_id/versions); the caller validates/trims the value.
  async renameTemplate(input: { tenant_id: string; id: string; name: string }) {
    const r = await this.prisma.documentTemplate.updateMany({
      where: { tenant_id: input.tenant_id, id: input.id },
      data: { name: input.name },
    });
    if (r.count === 0) throw new TemplateNotFoundError(input.id);
    return this.getTemplate(input.tenant_id, input.id);
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
  // Tenant-owned rows ONLY (unchanged). The owner-aware variant is
  // findTemplateByIdOwnerAware (DOC-TEMPLATE-LIB-1 §4.4).
  async findTemplateById(tenant_id: string, id: string) {
    return this.prisma.documentTemplate.findFirst({ where: { tenant_id, id } });
  }

  // ── DOC-TEMPLATE-LIB-1 T-1 — read union (§4.1) + owner-aware provenance (§4.4) ──
  // Every tenant read that may see Aramo defaults is an EXPLICIT union
  // `tenant_id = :tenant OR owner_scope = 'PLATFORM'` (precedent:
  // documents.repository.ts DocumentType read). A NULL tenant_id never matches by
  // accident: the PLATFORM arm names owner_scope, and the DB CHECK pins
  // tenant_id IS NULL ⇔ PLATFORM. Tenant admin listing/CRUD stays tenant-only
  // (listTemplates/getTemplate/getVersion) — these methods are additive.

  // Nullable template read: the tenant's own row or a PLATFORM default.
  async findTemplateByIdOwnerAware(tenant_id: string, id: string) {
    return this.prisma.documentTemplate.findFirst({
      where: { id, OR: [{ tenant_id }, { owner_scope: 'PLATFORM', tenant_id: null }] },
    });
  }

  // Nullable version read for provenance from a PINNED template_version_id. A tenant
  // Document may pin a PLATFORM version (tenant_id NULL, parent owner_scope
  // PLATFORM). Any status (a pinned version may since have been RETIRED).
  async findVersionByIdOwnerAware(tenant_id: string, id: string) {
    return this.prisma.templateVersion.findFirst({
      where: {
        id,
        OR: [{ tenant_id }, { tenant_id: null, template: { owner_scope: 'PLATFORM' } }],
      },
    });
  }

  // The tenant's own templates plus the Aramo (PLATFORM) defaults, optionally for one
  // DocumentType. Not wired to any tenant route in T-1 (Org Home gallery is T-4).
  async listTemplatesForTenantIncludingPlatform(tenant_id: string, document_type_id?: string) {
    return this.prisma.documentTemplate.findMany({
      where: {
        ...(document_type_id !== undefined ? { document_type_id } : {}),
        OR: [{ tenant_id }, { owner_scope: 'PLATFORM', tenant_id: null }],
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // DOC-TEMPLATE-LIB-1 T-4 (§8.2) — the version summaries the Org Home gallery shows for
  // the templates it lists (their CURRENT versions): owner-aware, so a PLATFORM default's
  // current version resolves for any tenant and another tenant's version never does.
  async listVersionSummariesOwnerAware(tenant_id: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.prisma.templateVersion.findMany({
      where: {
        id: { in: [...ids] },
        OR: [{ tenant_id }, { tenant_id: null, template: { owner_scope: 'PLATFORM' } }],
      },
      select: { id: true, template_id: true, version_number: true, status: true, activated_at: true, created_at: true },
    });
  }

  // ── DOC-TEMPLATE-LIB-1 T-3 — explicit selection (§4.2) ──────────────────────
  // TenantTemplateSelection is the tenant's active choice per (document type, optional
  // client). `client_id` null is the tenant-wide row; the DB unique index is NULLS NOT
  // DISTINCT so there is at most one tenant-wide row per type. The DB trigger
  // tenant_template_selection_target is the backstop for the target rule (PLATFORM or
  // same-tenant TENANT, same type); the app-level checks below give typed errors first.

  // Exact-key read: (tenant, type, client) with client null meaning the tenant-wide row.
  async findSelection(tenant_id: string, document_type_id: string, client_id: string | null) {
    return this.prisma.tenantTemplateSelection.findFirst({
      where: { tenant_id, document_type_id, client_id },
    });
  }

  async listSelections(tenant_id: string, document_type_id?: string) {
    return this.prisma.tenantTemplateSelection.findMany({
      where: { tenant_id, ...(document_type_id !== undefined ? { document_type_id } : {}) },
      orderBy: [{ document_type_id: 'asc' }, { selected_at: 'desc' }],
    });
  }

  // Set (insert or replace) the active choice for (tenant, type, client). The template
  // must be visible to the tenant (own row or PLATFORM; else TemplateNotFoundError — 404
  // concealment) and usable (else TemplateSelectionInvalidError). Atomic on the unique
  // index via ON CONFLICT, so a concurrent set never produces two rows.
  async upsertSelection(input: {
    tenant_id: string;
    document_type_id: string;
    client_id: string | null;
    template_id: string;
    selected_by: string;
  }) {
    const t = await this.findTemplateByIdOwnerAware(input.tenant_id, input.template_id);
    if (t === null || t.document_type_id !== input.document_type_id) throw new TemplateNotFoundError(input.template_id);
    // ORG-UX-1 §5.3 (conforming amendment row 4) — new selections name approved TENANT
    // templates only; an Aramo default is adopted, never selected directly.
    if (t.owner_scope === 'PLATFORM') throw new TemplateSelectionInvalidError(input.template_id, 'platform_template_not_selectable');
    if (t.status !== 'ACTIVE' || t.current_version_id === null) {
      throw new TemplateSelectionInvalidError(input.template_id, 'template_not_active');
    }
    if (t.owner_scope === 'PLATFORM' && t.withdraw_effective_at !== null && t.withdraw_effective_at <= new Date()) {
      throw new TemplateSelectionInvalidError(input.template_id, 'template_withdrawn');
    }
    if (t.owner_scope === 'TENANT' && t.client_id !== null && t.client_id !== input.client_id) {
      throw new TemplateSelectionInvalidError(input.template_id, 'template_client_mismatch');
    }
    return this.upsertSelectionRow(this.prisma, input);
  }

  // Remove the active choice for (tenant, type, client). Returns whether a row existed.
  // Removing the tenant-wide row means the type falls back to the Aramo default.
  async deleteSelection(tenant_id: string, document_type_id: string, client_id: string | null): Promise<boolean> {
    const r = await this.prisma.tenantTemplateSelection.deleteMany({
      where: { tenant_id, document_type_id, client_id },
    });
    return r.count > 0;
  }

  // The Aramo (PLATFORM) defaults for a type that a tenant may resolve right now: ACTIVE
  // and not past withdraw_effective_at (ADR-0034 D10 — a default whose withdrawal has
  // taken effect is never resolved). The caller validates current_version_id.
  async findResolvablePlatformDefaults(document_type_id: string, now: Date) {
    return this.prisma.documentTemplate.findMany({
      where: {
        owner_scope: 'PLATFORM',
        tenant_id: null,
        document_type_id,
        status: 'ACTIVE',
        OR: [{ withdraw_effective_at: null }, { withdraw_effective_at: { gt: now } }],
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
  }

  private async upsertSelectionRow(
    db: { $queryRaw: PrismaService['$queryRaw'] },
    input: { tenant_id: string; document_type_id: string; client_id: string | null; template_id: string; selected_by: string },
  ) {
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        tenant_id: string;
        document_type_id: string;
        client_id: string | null;
        template_id: string;
        selected_by: string;
        selected_at: Date;
      }>
    >`
      INSERT INTO "documents"."TenantTemplateSelection"
        ("id", "tenant_id", "document_type_id", "client_id", "template_id", "selected_by", "selected_at", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${input.tenant_id}::uuid, ${input.document_type_id}::uuid, ${input.client_id}::uuid,
              ${input.template_id}::uuid, ${input.selected_by}::uuid, now(), now(), now())
      ON CONFLICT ("tenant_id", "document_type_id", "client_id")
      DO UPDATE SET "template_id" = EXCLUDED."template_id", "selected_by" = EXCLUDED."selected_by",
                    "selected_at" = now(), "updated_at" = now(), "legacy_platform" = NULL
      RETURNING "id"::text, "tenant_id"::text, "document_type_id"::text, "client_id"::text, "template_id"::text,
                "selected_by"::text, "selected_at"`;
    const row = rows[0];
    if (row === undefined) throw new Error('TenantTemplateSelection upsert returned no row');
    return row;
  }

  // ORG-UX-1 (Directive v1.0 LOCKED §5.1, Lead Correction B) — ADOPT an Aramo default:
  // create an INDEPENDENT tenant-owned template + a DRAFT v1 whose content (and field
  // definitions) is a full copy of the default's CURRENT version at adoption time. The
  // tenant row records adopted_from_* for audit/provenance only — nothing ever reads them
  // to resolve, render or update, so later changes to the default never reach this copy.
  // Only a published, live (ACTIVE, pinned, not withdrawn) default may be adopted.
  async adoptPlatformTemplate(input: {
    tenant_id: string;
    library_template_id: string;
    created_by: string;
    transform?: DraftTransform;
  }) {
    const source = await this.prisma.documentTemplate.findFirst({
      where: { id: input.library_template_id, owner_scope: 'PLATFORM', tenant_id: null },
    });
    if (source === null) throw new TemplateNotFoundError(input.library_template_id);
    const now = new Date();
    if (
      source.status !== 'ACTIVE' ||
      source.current_version_id === null ||
      (source.withdraw_effective_at !== null && source.withdraw_effective_at <= now)
    ) {
      throw new TemplateSelectionInvalidError(input.library_template_id, 'template_not_adoptable');
    }
    const version = await this.prisma.templateVersion.findFirst({
      where: { id: source.current_version_id, template_id: source.id, tenant_id: null, status: 'ACTIVE' },
      include: { fields: true },
    });
    if (version === null) throw new TemplateSelectionInvalidError(input.library_template_id, 'template_not_adoptable');
    const base = {
      render_schema_version: version.render_schema_version,
      // A deep copy: the tenant draft never shares a JSON reference with the default.
      field_schema: version.field_schema === null ? undefined : (JSON.parse(JSON.stringify(version.field_schema)) as unknown),
    };
    const start = input.transform !== undefined ? input.transform(base) : base;
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.documentTemplate.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          document_type_id: source.document_type_id,
          client_id: null,
          name: source.name,
          description: source.description,
          template_kind: source.template_kind,
          status: 'DRAFT',
          created_by: input.created_by,
          adopted_from_template_id: source.id,
          adopted_from_version_id: version.id,
        },
      });
      const draft = await tx.templateVersion.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          template_id: template.id,
          version_number: 1,
          status: 'DRAFT',
          render_schema_version: start.render_schema_version,
          field_schema: (start.field_schema ?? undefined) as never,
          internal_notes: null,
          created_by: input.created_by,
          content_fingerprint: templateContentFingerprint(start.field_schema ?? null),
        },
      });
      for (const f of version.fields) {
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
      // M-A6 §3.4 — the copied field definitions are part of the draft's fingerprint.
      if (version.fields.length > 0) {
        const withFields = await tx.templateVersion.update({
          where: { id: draft.id },
          data: { content_fingerprint: templateContentFingerprint(start.field_schema ?? null, version.fields) },
        });
        return { template, version: withFields };
      }
      return { template, version: draft };
    });
  }

  // ── Versions ─────────────────────────────────────────────────────────────
  async createVersion(input: CreateVersionInput) {
    const { tenant_id, ...rest } = input;
    return this.createVersionFor(tenantOwner(tenant_id), rest);
  }

  private async createVersionFor(owner: TemplateOwner, input: Omit<CreateVersionInput, 'tenant_id'>) {
    await this.getTemplateFor(owner, input.template_id);
    const tenant_id = ownerTenantId(owner);
    // §41 one-DRAFT invariant — app-surface guard: if an open DRAFT already exists,
    // refuse (return/navigate to it at the caller). The partial unique index is the
    // concurrent-race backstop (mapOneDraftConflict below).
    const existingDraft = await this.prisma.templateVersion.findFirst({
      where: { tenant_id, template_id: input.template_id, status: 'DRAFT' },
    });
    if (existingDraft !== null) throw new TemplateDraftAlreadyExistsError(input.template_id, existingDraft.id);
    // Next version_number = max + 1 (unique tuple (template_id, version_number)).
    const last = await this.prisma.templateVersion.findFirst({
      where: { tenant_id, template_id: input.template_id },
      orderBy: { version_number: 'desc' },
    });
    const nextNumber = (last?.version_number ?? 0) + 1;
    try {
      return await this.prisma.templateVersion.create({
        data: {
          id: randomUUID(),
          tenant_id,
          template_id: input.template_id,
          version_number: nextNumber,
          status: 'DRAFT',
          render_schema_version: input.render_schema_version,
          field_schema: (input.field_schema ?? undefined) as never,
          binding_schema: (input.binding_schema ?? undefined) as never,
          source_artifact_id: input.source_artifact_id ?? null,
          effective_from: input.effective_from ?? null,
          internal_notes: input.internal_notes ?? null,
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
  //
  // A1 §2.1 — `transform` (supplied by the document-type capability) maps the ACTIVE
  // content to the content the new DRAFT starts from (rtr-generated-v1 → rtr-html-v1);
  // without it the content is copied verbatim (generic behaviour).
  async createDraftFromActive(input: {
    tenant_id: string;
    template_id: string;
    created_by: string;
    transform?: DraftTransform;
  }) {
    const { tenant_id, ...rest } = input;
    return this.createDraftFromActiveFor(tenantOwner(tenant_id), rest);
  }

  private async createDraftFromActiveFor(
    owner: TemplateOwner,
    input: { template_id: string; created_by: string; transform?: DraftTransform },
  ) {
    const template = await this.getTemplateFor(owner, input.template_id);
    const active =
      template.current_version_id !== null
        ? await this.prisma.templateVersion.findFirst({
            where: { ...versionWhere(owner), id: template.current_version_id },
          })
        : null;
    const base = {
      render_schema_version: active?.render_schema_version ?? 'rtr-generated-v1',
      field_schema: (active?.field_schema ?? undefined) as unknown,
    };
    const start = input.transform !== undefined && active !== null ? input.transform(base) : base;
    return this.createVersionFor(owner, {
      template_id: input.template_id,
      render_schema_version: start.render_schema_version,
      field_schema: start.field_schema ?? undefined,
      // Slice 1 B1 — the new DRAFT starts from the ACTIVE version's notes.
      internal_notes: active?.internal_notes ?? null,
      created_by: input.created_by,
    });
  }

  // §9 — update a DRAFT version's editable content. DRAFT-ONLY (ACTIVE/RETIRED →
  // TemplateImmutableError). Recomputes content_fingerprint and CLEARS
  // previewed_fingerprint so the §18 preview gate re-arms (editing invalidates a prior
  // preview). Never mutates version_number/status/tenant_id/template_id/created_by/
  // activated_*/retired_*.
  //
  // Slice 1 B1 — `internal_notes` (string|null; caller trims/validates ≤500) is also
  // DRAFT-editable. Notes are NOT rendered content, so a notes-only update leaves the
  // fingerprints (and therefore the §18 preview gate) untouched. `field_schema` is
  // optional only when `internal_notes` is supplied (the controller enforces one-of).
  async updateDraftVersion(input: {
    tenant_id: string;
    version_id: string;
    field_schema?: unknown;
    render_schema_version?: string;
    internal_notes?: string | null;
  }) {
    const { tenant_id, ...rest } = input;
    return this.updateDraftVersionFor(tenantOwner(tenant_id), rest);
  }

  private async updateDraftVersionFor(
    owner: TemplateOwner,
    input: { version_id: string; field_schema?: unknown; render_schema_version?: string; internal_notes?: string | null },
  ) {
    const v = await this.getVersionFor(owner, input.version_id);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    const contentEdit = input.field_schema !== undefined || input.render_schema_version !== undefined;
    return this.prisma.templateVersion.update({
      where: { id: input.version_id },
      data: {
        ...(input.field_schema !== undefined ? { field_schema: (input.field_schema ?? undefined) as never } : {}),
        ...(input.render_schema_version !== undefined
          ? { render_schema_version: input.render_schema_version }
          : {}),
        ...(input.internal_notes !== undefined ? { internal_notes: input.internal_notes } : {}),
        ...(contentEdit
          ? {
              content_fingerprint: templateContentFingerprint(
                input.field_schema !== undefined ? input.field_schema : (v.field_schema ?? null),
                await this.fingerprintFields(input.version_id),
              ),
              previewed_fingerprint: null, // re-arm the preview gate on any content edit
            }
          : {}),
      },
    });
  }

  // Document Templates slice 1 (B) — discard the open DRAFT version. DRAFT-ONLY:
  // ACTIVE/RETIRED → TemplateImmutableError (the same refusal as editing a non-DRAFT
  // version). Tenant-scoped (unknown/cross-tenant → TemplateVersionNotFoundError).
  // A DRAFT is never a template's current_version_id (only activation sets it), so
  // current_version_id and the ACTIVE version are untouched. The status-guarded
  // deleteMany is the race backstop: a version activated between the read and the
  // delete matches 0 rows and is refused as immutable, never deleted.
  async deleteDraftVersion(input: { tenant_id: string; version_id: string }): Promise<void> {
    const v = await this.getVersion(input.tenant_id, input.version_id);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.version_id);
    const deleted = await this.prisma.$transaction(async (tx) => {
      // FK is ON DELETE CASCADE; deleted explicitly so the intent is visible.
      await tx.templateFieldDefinition.deleteMany({ where: { template_version_id: input.version_id } });
      return tx.templateVersion.deleteMany({
        where: { tenant_id: input.tenant_id, id: input.version_id, status: 'DRAFT' },
      });
    });
    if (deleted.count === 0) throw new TemplateImmutableError(input.version_id);
  }

  // §18 — record that the CURRENT draft content has been previewed:
  // previewed_fingerprint := content_fingerprint. Deterministic + durable (not FE
  // state). DRAFT-only (admin preview-before-approval targets a DRAFT).
  async recordPreview(input: { tenant_id: string; version_id: string }) {
    return this.recordPreviewFor(tenantOwner(input.tenant_id), input.version_id);
  }

  private async recordPreviewFor(owner: TemplateOwner, version_id: string) {
    const v = await this.getVersionFor(owner, version_id);
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(version_id);
    // M-A6 §3.4 — the LIVE fingerprint (content + field definitions), never a stale stored one.
    const fp = templateContentFingerprint(v.field_schema ?? null, await this.fingerprintFields(version_id));
    return this.prisma.templateVersion.update({
      where: { id: version_id },
      data: { content_fingerprint: fp, previewed_fingerprint: fp },
    });
  }

  async listVersions(tenant_id: string, template_id: string) {
    return this.listVersionsFor(tenantOwner(tenant_id), template_id);
  }

  private async listVersionsFor(owner: TemplateOwner, template_id: string) {
    await this.getTemplateFor(owner, template_id);
    return this.prisma.templateVersion.findMany({
      where: { tenant_id: ownerTenantId(owner), template_id },
      orderBy: { version_number: 'asc' },
    });
  }

  async getVersion(tenant_id: string, id: string) {
    return this.getVersionFor(tenantOwner(tenant_id), id);
  }

  private async getVersionFor(owner: TemplateOwner, id: string) {
    const v = await this.prisma.templateVersion.findFirst({ where: { ...versionWhere(owner), id } });
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
    const { tenant_id, ...rest } = input;
    return this.activateVersionFor(tenantOwner(tenant_id), rest);
  }

  private async activateVersionFor(
    owner: TemplateOwner,
    input: { version_id: string; actor_id: string; require_preview?: boolean },
  ) {
    const v = await this.getVersionFor(owner, input.version_id);
    if (v.status === 'ACTIVE') return v; // no-op
    if (v.status === 'RETIRED') throw new TemplateImmutableError(input.version_id);
    if (input.require_preview !== false) {
      // M-A6 §3.4 — compared against the LIVE fingerprint (content + field definitions),
      // so a field added after the preview re-arms the gate whoever wrote it.
      const currentFp = templateContentFingerprint(v.field_schema ?? null, await this.fingerprintFields(input.version_id));
      if (v.previewed_fingerprint === null || v.previewed_fingerprint !== currentFp) {
        throw new TemplatePreviewRequiredError(input.version_id);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      // Retire the current ACTIVE version of this template, if any.
      await tx.templateVersion.updateMany({
        where: { tenant_id: ownerTenantId(owner), template_id: v.template_id, status: 'ACTIVE' },
        data: { status: 'RETIRED', retired_at: new Date() },
      });
      await tx.templateVersion.update({
        where: { id: input.version_id },
        data: { status: 'ACTIVE', activated_at: new Date(), activated_by: input.actor_id },
      });
      const tpl = await tx.documentTemplate.update({
        where: { id: v.template_id },
        data: { status: 'ACTIVE', current_version_id: input.version_id },
      });
      // DOC-TEMPLATE-LIB-1 T-3 (ADR-0034 D6 "approval switches it") — approving a TENANT
      // template makes it the tenant's active choice for its type (and its client, when
      // the template is client-scoped). Same transaction, so an approved version is never
      // left unselected. Re-approving the already-selected template is a no-op in effect.
      if (tpl.owner_scope === 'TENANT' && tpl.tenant_id !== null) {
        await this.upsertSelectionRow(tx, {
          tenant_id: tpl.tenant_id,
          document_type_id: tpl.document_type_id,
          client_id: tpl.client_id,
          template_id: tpl.id,
          selected_by: input.actor_id,
        });
      }
      return tx.templateVersion.findFirstOrThrow({ where: { id: input.version_id } });
    });
  }

  // ── DOC-TEMPLATE-LIB-1 T-2 — PLATFORM (Aramo default) authoring (§6.1, §8.1) ──
  // Called ONLY by the platform-tier controller (apps/api PlatformDocumentTemplates
  // Controller: consumer_type=platform + platform:document_template:*). Tenant routes
  // never reach these: they call the tenant methods above (tenant_id equality), which
  // cannot match a PLATFORM row. The DRAFT / §18 preview gate / activate logic is the
  // SAME code path the tenant admin flow uses (the *For(owner) primitives).

  async createPlatformTemplate(input: CreatePlatformTemplateInput) {
    return this.prisma.documentTemplate.create({
      data: {
        id: randomUUID(),
        tenant_id: null,
        owner_scope: 'PLATFORM',
        document_type_id: input.document_type_id,
        client_id: null,
        name: input.name,
        description: input.description ?? null,
        template_kind: input.template_kind,
        status: 'DRAFT',
        products: input.products,
        created_by: input.created_by,
      },
    });
  }

  // Each default with its version summaries (the list view derives the current ACTIVE
  // version + the open DRAFT from them).
  async listPlatformTemplates() {
    return this.prisma.documentTemplate.findMany({
      where: templateWhere(PLATFORM_OWNER),
      orderBy: { created_at: 'desc' },
      include: { versions: { select: { id: true, version_number: true, status: true, activated_at: true, created_at: true } } },
    });
  }

  // The SYSTEM document types (tenant_id NULL) — the only types an Aramo default may
  // target (a TENANT/CLIENT document type belongs to one tenant).
  async listSystemDocumentTypes() {
    return this.prisma.documentType.findMany({ where: { tenant_id: null, active: true }, orderBy: { key: 'asc' } });
  }

  async getPlatformTemplate(id: string) {
    return this.getTemplateFor(PLATFORM_OWNER, id);
  }

  // Name / description / product tags (D9: recorded, not enforced). Never touches
  // status / current_version_id / versions / withdrawal (T-6).
  async updatePlatformTemplate(id: string, patch: { name?: string; description?: string | null; products?: string[] }) {
    const r = await this.prisma.documentTemplate.updateMany({
      where: { ...templateWhere(PLATFORM_OWNER), id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.products !== undefined ? { products: patch.products } : {}),
      },
    });
    if (r.count === 0) throw new TemplateNotFoundError(id);
    return this.getPlatformTemplate(id);
  }

  async listPlatformVersions(template_id: string) {
    return this.listVersionsFor(PLATFORM_OWNER, template_id);
  }

  async getPlatformVersion(id: string) {
    return this.getVersionFor(PLATFORM_OWNER, id);
  }

  async createPlatformVersion(input: Omit<CreateVersionInput, 'tenant_id'>) {
    return this.createVersionFor(PLATFORM_OWNER, input);
  }

  async createPlatformDraftFromActive(input: { template_id: string; created_by: string; transform?: DraftTransform }) {
    return this.createDraftFromActiveFor(PLATFORM_OWNER, input);
  }

  async updatePlatformDraftVersion(input: {
    version_id: string;
    field_schema?: unknown;
    render_schema_version?: string;
    internal_notes?: string | null;
  }) {
    return this.updateDraftVersionFor(PLATFORM_OWNER, input);
  }

  async recordPlatformPreview(version_id: string) {
    return this.recordPreviewFor(PLATFORM_OWNER, version_id);
  }

  // Publish: DRAFT → ACTIVE behind the §18 preview gate (always required — no
  // bootstrap bypass on the platform surface); the prior ACTIVE version is RETIRED and
  // current_version_id moves, so tenants only ever resolve the current version (D3).
  //
  // DOC-TEMPLATE-LIB-1 T-6 (one live default per type) — the FIRST publish of a default
  // makes it live, so it is refused (409 platform_default_live) while another default of
  // the same type is live (ACTIVE, no withdrawal published). The partial unique index
  // DocumentTemplate_one_live_platform_default is the race backstop, mapped to the same
  // typed refusal. Publishing a new version of a default whose withdrawal has TAKEN
  // EFFECT is refused (nobody resolves it any more). During the notice window a new
  // version may still be published (tenants still use it until the effective date).
  async activatePlatformVersion(input: { version_id: string; actor_id: string }) {
    const v = await this.getVersionFor(PLATFORM_OWNER, input.version_id);
    const t = await this.getTemplateFor(PLATFORM_OWNER, v.template_id);
    if (t.withdraw_effective_at !== null && t.withdraw_effective_at.getTime() <= Date.now()) {
      throw new TemplatePlatformDefaultConflictError(t.id, 'withdrawal_in_effect', {
        withdraw_effective_at: t.withdraw_effective_at.toISOString(),
      });
    }
    if (t.status !== 'ACTIVE') {
      const live = await this.findLivePlatformDefault(t.document_type_id, t.id);
      if (live !== null) throw new TemplatePlatformDefaultConflictError(t.id, 'platform_default_live', { live_template_id: live.id });
    }
    try {
      return await this.activateVersionFor(PLATFORM_OWNER, { ...input, require_preview: true });
    } catch (e) {
      throw mapOneLiveDefaultConflict(e, t.id);
    }
  }

  // ── DOC-TEMPLATE-LIB-1 T-6 — withdrawal (§9; ADR-0034 D10) ─────────────────
  // Publishing a withdrawal sets withdraw_notice_at = now and withdraw_effective_at =
  // now + notice_days. Until the effective date the default is still resolved (notice
  // window, Org Home banner). From the effective date the resolver never resolves it and
  // falls back to the tenant's own approved template, else TEMPLATE_SELECTION_REQUIRED.
  // Generated documents keep their pinned version (versions are never touched here).

  // The live default of a type (ACTIVE, no withdrawal published), other than `exceptId`.
  async findLivePlatformDefault(document_type_id: string, exceptId?: string) {
    return this.prisma.documentTemplate.findFirst({
      where: {
        ...templateWhere(PLATFORM_OWNER),
        document_type_id,
        status: 'ACTIVE',
        withdraw_effective_at: null,
        ...(exceptId !== undefined ? { id: { not: exceptId } } : {}),
      },
    });
  }

  // `beforeWrite` runs after every state check and before the conditional write (the
  // platform controller writes the audit event there — no withdrawal without its audit
  // record; a failing hook aborts the withdrawal).
  async withdrawPlatformTemplate(input: {
    id: string;
    notice_days: number;
    now?: Date;
    beforeWrite?: (planned: { template: { id: string; document_type_id: string }; withdraw_notice_at: Date; withdraw_effective_at: Date }) => Promise<void>;
  }) {
    const now = input.now ?? new Date();
    const t = await this.getPlatformTemplate(input.id);
    if (t.status !== 'ACTIVE' || t.current_version_id === null) {
      throw new TemplatePlatformDefaultConflictError(t.id, 'template_not_published', { status: t.status });
    }
    if (t.withdraw_effective_at !== null) {
      throw new TemplatePlatformDefaultConflictError(t.id, 'already_withdrawn', {
        withdraw_effective_at: t.withdraw_effective_at.toISOString(),
      });
    }
    const effective = new Date(now.getTime() + input.notice_days * DAY_MS);
    if (input.beforeWrite !== undefined) {
      await input.beforeWrite({ template: t, withdraw_notice_at: now, withdraw_effective_at: effective });
    }
    // Conditional write: a concurrent withdrawal of the same default loses cleanly.
    const r = await this.prisma.documentTemplate.updateMany({
      where: { ...templateWhere(PLATFORM_OWNER), id: t.id, status: 'ACTIVE', withdraw_effective_at: null },
      data: { withdraw_notice_at: now, withdraw_effective_at: effective },
    });
    if (r.count === 0) throw new TemplatePlatformDefaultConflictError(t.id, 'already_withdrawn');
    return this.getPlatformTemplate(t.id);
  }

  // Cancel a PENDING withdrawal (effective date still ahead). Refused once it has taken
  // effect, when none is pending, and while a replacement default of the same type is
  // live (one live default per type — the index backstops the race).
  async cancelPlatformWithdrawal(input: {
    id: string;
    now?: Date;
    beforeWrite?: (current: { template: { id: string; document_type_id: string }; withdraw_notice_at: Date | null; withdraw_effective_at: Date }) => Promise<void>;
  }) {
    const now = input.now ?? new Date();
    const t = await this.getPlatformTemplate(input.id);
    if (t.withdraw_effective_at === null) throw new TemplatePlatformDefaultConflictError(t.id, 'not_withdrawn');
    if (t.withdraw_effective_at.getTime() <= now.getTime()) {
      throw new TemplatePlatformDefaultConflictError(t.id, 'withdrawal_in_effect', {
        withdraw_effective_at: t.withdraw_effective_at.toISOString(),
      });
    }
    if (t.status === 'ACTIVE') {
      const live = await this.findLivePlatformDefault(t.document_type_id, t.id);
      if (live !== null) throw new TemplatePlatformDefaultConflictError(t.id, 'platform_default_live', { live_template_id: live.id });
    }
    if (input.beforeWrite !== undefined) {
      await input.beforeWrite({ template: t, withdraw_notice_at: t.withdraw_notice_at, withdraw_effective_at: t.withdraw_effective_at });
    }
    let count: number;
    try {
      const r = await this.prisma.documentTemplate.updateMany({
        where: { ...templateWhere(PLATFORM_OWNER), id: t.id, withdraw_effective_at: { gt: now } },
        data: { withdraw_notice_at: null, withdraw_effective_at: null },
      });
      count = r.count;
    } catch (e) {
      throw mapOneLiveDefaultConflict(e, t.id);
    }
    if (count === 0) throw new TemplatePlatformDefaultConflictError(t.id, 'withdrawal_in_effect');
    return this.getPlatformTemplate(t.id);
  }

  // The Aramo defaults with a published withdrawal whose effective date is after `since`
  // (pending notices, plus recently effective ones when `since` is in the past — the
  // tenant notice grace window). Ordered by effective date.
  async listPlatformWithdrawals(since: Date) {
    return this.prisma.documentTemplate.findMany({
      where: { ...templateWhere(PLATFORM_OWNER), withdraw_notice_at: { not: null }, withdraw_effective_at: { gt: since } },
      orderBy: [{ withdraw_effective_at: 'asc' }, { id: 'asc' }],
    });
  }

  // §9 tenant notice — the Aramo default withdrawals THIS tenant relies on: pending ones,
  // and ones that took effect less than `grace_days` ago. A tenant relies on a default
  // when one of its selections names it, or when it has no tenant-wide selection for the
  // type and no other live default (no withdrawal published) would be resolved instead.
  // Product tags are returned as recorded and NEVER filter (ADR-0034 D9 — not enforced).
  // The only tenant data read is the caller's own selections / templates.
  async listWithdrawalNoticesForTenant(input: { tenant_id: string; now?: Date; grace_days: number }) {
    const now = input.now ?? new Date();
    const withdrawals = await this.listPlatformWithdrawals(new Date(now.getTime() - input.grace_days * DAY_MS));
    if (withdrawals.length === 0) return [];
    const selections = await this.listSelections(input.tenant_id);
    const out: Array<{
      template_id: string;
      name: string;
      document_type_id: string;
      products: string[];
      withdraw_notice_at: Date;
      withdraw_effective_at: Date;
      in_effect: boolean;
      selected_for_client_ids: Array<string | null>;
      relies_on_default: boolean;
      has_own_template: boolean;
    }> = [];
    for (const w of withdrawals) {
      if (w.withdraw_notice_at === null || w.withdraw_effective_at === null) continue;
      // ORG-UX-1 §5.3 — gallery-first: a tenant relies on an Aramo default ONLY through a
      // grandfathered (legacy) selection naming it; a tenant with no selection has no
      // fallback to any default, so it is never affected by a withdrawal.
      const legacy = selections.filter((s) => s.template_id === w.id && s.legacy_platform === true);
      const selected = legacy.map((s) => s.client_id);
      const relies_on_default = legacy.some((s) => s.client_id === null);
      if (selected.length === 0 && !relies_on_default) continue;
      const own = await this.prisma.documentTemplate.count({
        where: {
          tenant_id: input.tenant_id,
          owner_scope: 'TENANT',
          document_type_id: w.document_type_id,
          status: 'ACTIVE',
          current_version_id: { not: null },
        },
      });
      out.push({
        template_id: w.id,
        name: w.name,
        document_type_id: w.document_type_id,
        products: w.products ?? [],
        withdraw_notice_at: w.withdraw_notice_at,
        withdraw_effective_at: w.withdraw_effective_at,
        in_effect: w.withdraw_effective_at.getTime() <= now.getTime(),
        selected_for_client_ids: selected,
        relies_on_default,
        has_own_template: own > 0,
      });
    }
    return out;
  }

  // Ids of the Aramo defaults of a type whose withdrawal has taken effect at `now`.
  async listWithdrawnPlatformDefaultIds(document_type_id: string, now: Date): Promise<string[]> {
    const rows = await this.prisma.documentTemplate.findMany({
      where: { ...templateWhere(PLATFORM_OWNER), document_type_id, status: 'ACTIVE', withdraw_effective_at: { lte: now } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  // The tenant's own ACTIVE templates of a type that a withdrawal fallback may use: for a
  // known client, that client's templates first, then the tenant-wide ones. Within each
  // group most recently approved first (current version activated_at, then id). Rows
  // without a current version are excluded (the resolver pins current_version_id).
  // Amendment M-A6 (LOCKED) §3.1 — ADR-0034 D6 amended for Sign listing only: every ACTIVE
  // template the tenant may use for a document type — its own ACTIVE TENANT templates
  // (tenant-wide, plus the client's when a client is named) and the Aramo (PLATFORM)
  // defaults it adopted through a grandfathered selection (legacy_platform = true, the only
  // way a PLATFORM template is usable after ORG-UX-1 §5.3), ACTIVE and not past
  // withdraw_effective_at. Each row has a current version (the caller pins it). An explicit
  // own-tenant ∪ PLATFORM union (ADR-0034 §4.1); the automatic resolution is untouched.
  async listUsableTemplatesForTenant(tenant_id: string, document_type_id: string, client_id: string | null, now: Date) {
    const clientScope = client_id === null ? [{ client_id: null }] : [{ client_id: null }, { client_id }];
    const own = await this.prisma.documentTemplate.findMany({
      where: { tenant_id, owner_scope: 'TENANT', document_type_id, status: 'ACTIVE', current_version_id: { not: null }, OR: clientScope },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const adopted = await this.prisma.tenantTemplateSelection.findMany({
      where: { tenant_id, document_type_id, legacy_platform: true, OR: clientScope },
      select: { template_id: true },
    });
    const platform =
      adopted.length === 0
        ? []
        : await this.prisma.documentTemplate.findMany({
            where: {
              id: { in: [...new Set(adopted.map((a) => a.template_id))] },
              owner_scope: 'PLATFORM',
              tenant_id: null,
              document_type_id,
              status: 'ACTIVE',
              current_version_id: { not: null },
              OR: [{ withdraw_effective_at: null }, { withdraw_effective_at: { gt: now } }],
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
          });
    return [...own, ...platform];
  }

  async listTenantFallbackTemplates(tenant_id: string, document_type_id: string, client_id: string | null) {
    const rows = await this.prisma.documentTemplate.findMany({
      where: {
        tenant_id,
        owner_scope: 'TENANT',
        document_type_id,
        status: 'ACTIVE',
        current_version_id: { not: null },
        client_id,
      },
    });
    const tenantWide =
      client_id === null
        ? []
        : await this.prisma.documentTemplate.findMany({
            where: { tenant_id, owner_scope: 'TENANT', document_type_id, status: 'ACTIVE', current_version_id: { not: null }, client_id: null },
          });
    const all = [...rows, ...tenantWide];
    const versionIds = all.map((t) => t.current_version_id).filter((id): id is string => id !== null);
    const versions = await this.prisma.templateVersion.findMany({
      where: { id: { in: versionIds }, tenant_id },
      select: { id: true, activated_at: true },
    });
    const activated = new Map(versions.map((v) => [v.id, v.activated_at?.getTime() ?? 0]));
    const recency = (t: (typeof all)[number]): number => (t.current_version_id === null ? 0 : (activated.get(t.current_version_id) ?? 0));
    const order = (a: (typeof all)[number], b: (typeof all)[number]): number => recency(b) - recency(a) || (a.id < b.id ? -1 : 1);
    return [...rows.sort(order), ...tenantWide.sort(order)];
  }

  // ── Fields (canonical field model, NOT AcroForm) ─────────────────────────
  async addField(input: AddFieldInput) {
    const v = await this.getVersion(input.tenant_id, input.template_version_id);
    // A field is content: it cannot be added once the version is ACTIVE.
    if (v.status !== 'DRAFT') throw new TemplateImmutableError(input.template_version_id);
    const created = await this.prisma.templateFieldDefinition.create({
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
    // M-A6 §3.4 — a field is content: it joins the fingerprint and re-arms the preview gate.
    await this.prisma.templateVersion.update({
      where: { id: input.template_version_id },
      data: {
        content_fingerprint: templateContentFingerprint(v.field_schema ?? null, await this.fingerprintFields(input.template_version_id)),
        previewed_fingerprint: null,
      },
    });
    return created;
  }

  private async fingerprintFields(template_version_id: string): Promise<FingerprintField[]> {
    return this.prisma.templateFieldDefinition.findMany({ where: { template_version_id }, orderBy: { ordinal: 'asc' } });
  }

  async listFields(tenant_id: string, template_version_id: string) {
    await this.getVersion(tenant_id, template_version_id);
    return this.prisma.templateFieldDefinition.findMany({
      where: { template_version_id },
      orderBy: { ordinal: 'asc' },
    });
  }

  // DOC-TEMPLATE-LIB-1 T-5 — the field definitions of a version the tenant may read (its
  // own, or an Aramo default's — owner-aware like findVersionByIdOwnerAware). Empty when
  // the version is unknown / another tenant's.
  async listFieldDefinitionsOwnerAware(tenant_id: string, template_version_id: string) {
    const v = await this.findVersionByIdOwnerAware(tenant_id, template_version_id);
    if (v === null) return [];
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

  // A1 §2.4 — tenant-scoped asset read (null when unknown / cross-tenant).
  // DOC-TEMPLATE-LIB-1 §3.5 [TD]: TemplateAsset stays tenant-only — PLATFORM content
  // carries no tenant asset (branding is bound at render, T-3), so the owner-aware
  // read of an asset IS this tenant-scoped read.
  async findAssetById(tenant_id: string, id: string) {
    return this.prisma.templateAsset.findFirst({ where: { tenant_id, id } });
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
