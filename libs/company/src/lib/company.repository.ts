import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';

import type { CompanyView, CompanyRelationshipView } from './dto/company.view.js';
import { stripUnscopedCommercialFields } from './commercial-write-strip.js';
import type {
  CreateCompanyRequestDto,
  CompanyRelationshipInput,
} from './dto/create-company-request.dto.js';
import type { UpdateCompanyRequestDto } from './dto/update-company-request.dto.js';
import {
  QUIET_DAYS,
  type CompanyFacetBucket,
  type CompanyFacets,
  type CompanySearchPage,
  type CompanySearchQuery,
  type CompanySortKey,
  type SortDir,
} from './dto/company-search.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Decimal columns (default_contract_markup_pct / default_perm_fee_pct) come
// back from Prisma as a Decimal instance; projected to string on the wire
// (no float drift — the compensation pattern). Typed structurally so the
// repo needn't import the generated Prisma.Decimal.
type DecimalLike = { toString(): string };

// Company Party/Role (ADR-0032) — the relationship row shape as returned by
// Prisma when `relationships` is included on a Company read.
interface CompanyRelationshipRow {
  id: string;
  type: string;
  status: string;
  effective_from: Date | null;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Read include for the relationship child — ordered so the projected view is
// stable across reads.
const RELATIONSHIP_INCLUDE = {
  relationships: { orderBy: { type: 'asc' } },
} as const;

function projectRelationship(r: CompanyRelationshipRow): CompanyRelationshipView {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    effective_from: r.effective_from !== null ? r.effective_from.toISOString() : null,
    effective_to: r.effective_to !== null ? r.effective_to.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

// Legacy Company.status → relationship status (UPPERCASE). Returns null for
// do_not_contact (a communication restriction, NOT a relationship lifecycle
// state — §5/§R1): the caller rejects a legacy create and preserves status on
// a legacy update. An omitted status defaults to the column default ('active').
export function legacyStatusToRelStatus(status: string | undefined): string | null {
  const s = status ?? 'active';
  if (s === 'prospect') return 'PROSPECT';
  if (s === 'active') return 'ACTIVE';
  if (s === 'inactive') return 'INACTIVE';
  return null; // do_not_contact or any unmapped value
}

// A relationship input → the nested-create shape. tenant_id/company_id are the
// composite-relation scalars and are populated by Prisma from the parent, so
// they are NOT set here. status defaults to PROSPECT for a newly-declared
// relationship; effective_from defaults to now (current episode).
function relInputToCreate(r: CompanyRelationshipInput): {
  type: string;
  status: string;
  effective_from: Date;
  effective_to: Date | null;
} {
  return {
    type: r.type,
    status: r.status ?? 'PROSPECT',
    effective_from: r.effective_from == null ? new Date() : new Date(r.effective_from),
    effective_to: r.effective_to == null ? null : new Date(r.effective_to),
  };
}

// Company Party/Role (ADR-0032) — the relationships to nested-create with a new
// Company. Relationship-aware clients (Slice B) send `relationships` explicitly
// (Amendment 4: ≥1 at the UI boundary). When OMITTED, the A1 compatibility
// bridge derives a single CLIENT relationship from the legacy `status`; a
// legacy create with status=do_not_contact is REJECTED (§5) — the restriction
// is a communication flag, not a relationship lifecycle state.
export function buildCreateRelationships(
  input: CreateCompanyRequestDto,
  requestId?: string,
): Array<{ type: string; status: string; effective_from: Date; effective_to: Date | null }> {
  if (input.relationships !== undefined && input.relationships.length > 0) {
    return input.relationships.map(relInputToCreate);
  }
  const relStatus = legacyStatusToRelStatus(input.status);
  if (relStatus === null) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'A company cannot be created with status=do_not_contact and no explicit relationship — do_not_contact is a communication restriction, not a relationship lifecycle state. Set communication_restricted and declare a relationship instead.',
      400,
      { requestId: requestId ?? 'company-create-validation', details: { status: input.status } },
    );
  }
  return [
    { type: 'CLIENT', status: relStatus, effective_from: new Date(), effective_to: null },
  ];
}

// Company Party/Role (ADR-0032) — the nested `relationships.upsert` set for an
// update. Two sources: (a) explicit relationship-aware writes (Slice B) — upsert
// each by (tenant, company, type), reusing the row on reactivation (§6); (b) the
// A1 bridge — a legacy `status` PATCH syncs the CLIENT relationship's status.
// A do_not_contact status PATCH produces NO relationship change (the existing
// lifecycle status is preserved; the restriction is carried on the company via
// communication_restricted — §5). `where` uses the compound unique; `create`
// omits the relation scalars (Prisma sets them from the parent). On update we
// only touch effective_* when the caller explicitly supplied them, so a
// status-only change never resets the episode window.
export function buildUpdateRelationshipUpserts(
  input: UpdateCompanyRequestDto,
  tenant_id: string,
  company_id: string,
): Array<{
  where: { tenant_id_company_id_type: { tenant_id: string; company_id: string; type: string } };
  update: { status: string; effective_from?: Date; effective_to?: Date | null };
  create: { type: string; status: string; effective_from: Date; effective_to: Date | null };
}> {
  const key = (type: string) => ({
    tenant_id_company_id_type: { tenant_id, company_id, type },
  });
  if (input.relationships !== undefined) {
    return input.relationships.map((r) => {
      const c = relInputToCreate(r);
      return {
        where: key(c.type),
        update: {
          status: c.status,
          ...(r.effective_from !== undefined ? { effective_from: c.effective_from } : {}),
          ...(r.effective_to !== undefined ? { effective_to: c.effective_to } : {}),
        },
        create: {
          type: c.type,
          status: c.status,
          effective_from: c.effective_from,
          effective_to: c.effective_to,
        },
      };
    });
  }
  if (input.status !== undefined) {
    const relStatus = legacyStatusToRelStatus(input.status);
    if (relStatus !== null) {
      return [
        {
          where: key('CLIENT'),
          update: { status: relStatus },
          create: { type: 'CLIENT', status: relStatus, effective_from: new Date(), effective_to: null },
        },
      ];
    }
    // do_not_contact — preserve the existing relationship status (no entry).
  }
  return [];
}

// CompanyRepository — write + read surface for Company. Reference-CRUD
// per Ruling 7 (no metering, no event log, no state machine).
//
// Every method scopes by tenant_id (Architecture §7.2). site_id is the
// caller's responsibility at the controller layer: the route's
// @RequireSiteMatch + the JWT site claim govern axis enforcement; the
// repository writes the site_id verbatim and trusts the controller.

interface CompanyRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  name: string;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone1: string | null;
  phone2: string | null;
  fax_number: string | null;
  url: string | null;
  key_technologies: string | null;
  notes: string | null;
  is_hot: boolean;
  billing_contact_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  // Company-Fields v1.1 — un-gated.
  status: string;
  // Company Party/Role (ADR-0032).
  master_status: string;
  communication_restricted: boolean;
  description: string | null;
  industry: string | null;
  country: string | null;
  employee_count_band: string | null;
  annual_revenue_band: string | null;
  founded_year: number | null;
  ownership_type: string | null;
  registration_number: string | null;
  source: string | null;
  client_tier: string | null;
  supplier_status: string | null;
  exclusivity: boolean;
  off_limits: boolean;
  tags: string[];
  general_email: string | null;
  last_activity_at: Date | null;
  next_action_at: Date | null;
  // Address-Autocomplete v1.0 — provider place reference.
  address_provider_place_id: string | null;
  address_provider: string | null;
  // Company-Fields v1.1 — gated commercial (Decimal cols as DecimalLike).
  fee_model: string | null;
  default_contract_markup_pct: DecimalLike | null;
  default_perm_fee_pct: DecimalLike | null;
  payment_terms: string | null;
  credit_status: string | null;
  default_currency: string | null;
  // Company Party/Role (ADR-0032) — present when the read includes it.
  relationships?: CompanyRelationshipRow[];
}

function projectView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    name: row.name,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone1: row.phone1,
    phone2: row.phone2,
    fax_number: row.fax_number,
    url: row.url,
    key_technologies: row.key_technologies,
    notes: row.notes,
    is_hot: row.is_hot,
    billing_contact_id: row.billing_contact_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    // Company-Fields v1.1 — un-gated.
    status: row.status,
    // Company Party/Role (ADR-0032) — additive; status retained (A1 expand).
    master_status: row.master_status,
    communication_restricted: row.communication_restricted,
    relationships: (row.relationships ?? []).map(projectRelationship),
    description: row.description,
    industry: row.industry,
    country: row.country,
    employee_count_band: row.employee_count_band,
    annual_revenue_band: row.annual_revenue_band,
    founded_year: row.founded_year,
    ownership_type: row.ownership_type,
    registration_number: row.registration_number,
    source: row.source,
    client_tier: row.client_tier,
    supplier_status: row.supplier_status,
    exclusivity: row.exclusivity,
    off_limits: row.off_limits,
    tags: row.tags,
    general_email: row.general_email,
    last_activity_at:
      row.last_activity_at !== null ? row.last_activity_at.toISOString() : null,
    next_action_at:
      row.next_action_at !== null ? row.next_action_at.toISOString() : null,
    // Address-Autocomplete v1.0 — provider place reference (un-gated).
    address_provider_place_id: row.address_provider_place_id,
    address_provider: row.address_provider,
    // Company-Fields v1.1 — gated commercial (Decimal → string; interceptor
    // omits these keys for non-holders of company:read_commercial).
    fee_model: row.fee_model,
    default_contract_markup_pct:
      row.default_contract_markup_pct !== null
        ? row.default_contract_markup_pct.toString()
        : null,
    default_perm_fee_pct:
      row.default_perm_fee_pct !== null
        ? row.default_perm_fee_pct.toString()
        : null,
    payment_terms: row.payment_terms,
    credit_status: row.credit_status,
    default_currency: row.default_currency,
  };
}

// Company-Fields v1.1 — boundary coercion for the NEW typed columns. The
// deepest write boundary all callers traverse (create / createForImport /
// update), so a blank form field, a stray "" from any client, or a numeric
// string never reaches Prisma as an un-parseable value:
//   - Decimal cols (default_contract_markup_pct / default_perm_fee_pct):
//     "" → null  (Prisma: "Failed to parse empty string. Expected decimal").
//   - Int (founded_year): "" → null; numeric string → number; else → null.
//   - DateTime? rollups (last_activity_at / next_action_at): "" → null.
//   - String[] (tags): a non-array (e.g. "") → undefined (omitted, never sent
//     as a bare string — Prisma rejects String for a String[] column).
// String columns ("" is a valid TEXT value) are left untouched. Idempotent.
export function normalizeNewTypedFields<T>(input: T): T {
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const k of [
    'default_contract_markup_pct',
    'default_perm_fee_pct',
    'last_activity_at',
    'next_action_at',
  ]) {
    if (out[k] === '') out[k] = null;
  }
  if ('founded_year' in out) {
    const v = out['founded_year'];
    if (v === '') {
      out['founded_year'] = null;
    } else if (typeof v === 'string') {
      const n = Number.parseInt(v, 10);
      out['founded_year'] = Number.isFinite(n) ? n : null;
    }
  }
  if ('tags' in out && !Array.isArray(out['tags'])) {
    out['tags'] = undefined;
  }
  return out as T;
}

// Company-Fields v1.1 — the new-column CREATE block (un-gated + commercial).
// Nullable columns are written as null when omitted; the DEFAULTed columns
// (status / exclusivity / tags / default_currency) are OMITTED when not
// supplied so the DB @default applies. Commercial fields arrive here already
// stripped for non-holders (the repo strips before calling this), so a
// non-holder's create writes null/default for them.
function additiveCreateData(input: CreateCompanyRequestDto) {
  return {
    description: input.description ?? null,
    industry: input.industry ?? null,
    country: input.country ?? null,
    employee_count_band: input.employee_count_band ?? null,
    annual_revenue_band: input.annual_revenue_band ?? null,
    founded_year: input.founded_year ?? null,
    ownership_type: input.ownership_type ?? null,
    registration_number: input.registration_number ?? null,
    source: input.source ?? null,
    client_tier: input.client_tier ?? null,
    supplier_status: input.supplier_status ?? null,
    general_email: input.general_email ?? null,
    fee_model: input.fee_model ?? null,
    default_contract_markup_pct: input.default_contract_markup_pct ?? null,
    default_perm_fee_pct: input.default_perm_fee_pct ?? null,
    payment_terms: input.payment_terms ?? null,
    credit_status: input.credit_status ?? null,
    // Address-Autocomplete v1.0 — provider place reference (nullable; null when
    // the address was typed manually).
    address_provider_place_id: input.address_provider_place_id ?? null,
    address_provider: input.address_provider ?? null,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.exclusivity === undefined ? {} : { exclusivity: input.exclusivity }),
    ...(input.off_limits === undefined ? {} : { off_limits: input.off_limits }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.default_currency === undefined
      ? {}
      : { default_currency: input.default_currency }),
  };
}

// ── Phase 2 — server-side faceted search helpers (single-schema) ──

// Opaque keyset cursor = the last row id (base64url). Correctness comes from the
// deterministic orderBy (sort col(s) + id tiebreak) + Prisma cursor/skip.
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

// Each sort ends with `id` so the keyset is total-ordered (no skips/dupes).
function buildCompanyOrderBy(
  sort: CompanySortKey,
  dir: SortDir,
): Array<Record<string, SortDir>> {
  switch (sort) {
    case 'name':
      return [{ name: dir }, { id: dir }];
    case 'last_activity':
      return [{ last_activity_at: dir }, { id: dir }];
    case 'created_at':
      return [{ created_at: dir }, { id: dir }];
  }
}

// The BASE where — tenant + site + name-search + owner scope + D4b visibility.
// Facet counts and `total` are computed over THIS (selection-independent).
function buildBaseWhere(
  q: CompanySearchQuery,
  visibility: VisibilityContextShape,
): Record<string, unknown> {
  const where: Record<string, unknown> = { tenant_id: q.tenant_id };
  if (q.site_id !== undefined) where['site_id'] = q.site_id;
  if (q.q !== undefined && q.q !== '')
    where['name'] = { contains: q.q, mode: 'insensitive' };
  if (q.owner_id !== undefined) where['owner_id'] = q.owner_id;
  if (!visibility.see_all_company) {
    const visible = visibility.visible_client_ids;
    if (visible !== null) where['id'] = { in: Array.from(visible) };
  }
  return where;
}

function quietCutoff(): Date {
  return new Date(Date.now() - QUIET_DAYS * 86_400_000);
}

// The selection where = base + the relationship/tier/industry/flag/quiet picks.
function buildSelectionWhere(
  base: Record<string, unknown>,
  q: CompanySearchQuery,
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...base };
  // Company Party/Role (ADR-0032, VR5/Amendment 6) — relationship filter over
  // CompanyRelationship. A company matches when it has ≥1 relationship
  // satisfying BOTH the selected type(s) AND status(es) (some-relationship
  // semantics): `Clients + Active` → a CLIENT relationship that is ACTIVE;
  // `All + Active` → any relationship that is ACTIVE.
  const relType = q.relationship_type;
  const relStatus = q.relationship_status;
  if ((relType !== undefined && relType.length > 0) || (relStatus !== undefined && relStatus.length > 0)) {
    where['relationships'] = {
      some: {
        ...(relType !== undefined && relType.length > 0 ? { type: { in: [...relType] } } : {}),
        ...(relStatus !== undefined && relStatus.length > 0 ? { status: { in: [...relStatus] } } : {}),
      },
    };
  }
  if (q.client_tier !== undefined && q.client_tier.length > 0)
    where['client_tier'] = { in: [...q.client_tier] };
  if (q.industry !== undefined && q.industry.length > 0)
    where['industry'] = { in: [...q.industry] };
  if (q.is_hot === true) where['is_hot'] = true;
  if (q.off_limits === true) where['off_limits'] = true;
  if (q.exclusivity === true) where['exclusivity'] = true;
  if (q.quiet === true) {
    where['OR'] = [
      { last_activity_at: null },
      { last_activity_at: { lt: quietCutoff() } },
    ];
  }
  return where;
}

interface CompanyGroupRow {
  readonly _count: { readonly _all: number };
  readonly [key: string]: unknown;
}

function toCompanyBuckets(
  rows: readonly CompanyGroupRow[],
  key: string,
  opts: { dropNullOrEmpty?: boolean } = {},
): CompanyFacetBucket[] {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    if (
      raw === null ||
      raw === undefined ||
      (typeof raw === 'string' && raw.trim() === '')
    ) {
      if (opts.dropNullOrEmpty === true) continue;
      continue;
    }
    const value = String(raw);
    tally.set(value, (tally.get(value) ?? 0) + r._count._all);
  }
  return [...tally.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

@Injectable()
export class CompanyRepository {
  private readonly logger = new Logger(CompanyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateCompanyRequestDto;
    // Company-Fields v1.1 — the actor's scopes; commercial fields are
    // stripped from the input when company:read_commercial is absent.
    scopes: readonly string[];
    // Company Party/Role (ADR-0032) — optional, for the do_not_contact
    // legacy-create rejection error envelope (§5). Threaded by the controller.
    requestId?: string;
  }): Promise<CompanyView> {
    const { tenant_id, entered_by_id } = args;
    const input = normalizeNewTypedFields(
      stripUnscopedCommercialFields(args.input, args.scopes),
    );
    // Company Party/Role (ADR-0032) — derive/collect the relationships to
    // nested-create (A1 bridge or explicit); rejects a do_not_contact legacy
    // create before any write.
    const relCreate = buildCreateRelationships(input, args.requestId);
    const row = await this.prisma.company.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        name: input.name,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        phone1: input.phone1 ?? null,
        phone2: input.phone2 ?? null,
        fax_number: input.fax_number ?? null,
        url: input.url ?? null,
        key_technologies: input.key_technologies ?? null,
        notes: input.notes ?? null,
        is_hot: input.is_hot ?? false,
        billing_contact_id: input.billing_contact_id ?? null,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
        ...additiveCreateData(input),
        ...(input.communication_restricted === undefined
          ? {}
          : { communication_restricted: input.communication_restricted }),
        relationships: { create: relCreate },
      },
      include: RELATIONSHIP_INCLUDE,
    });
    return projectView(row as CompanyRow);
  }

  // PR-A8-1 — import-engine create. Identical to create() except the
  // row carries `import_batch_id` so deleteByImportBatch can revert it.
  // Kept separate from the free create() surface so the public
  // free-form CRUD never accidentally attributes a row to a batch.
  async createForImport(args: {
    tenant_id: string;
    entered_by_id: string;
    import_batch_id: string;
    input: CreateCompanyRequestDto;
    requestId?: string;
  }): Promise<CompanyView> {
    const { tenant_id, entered_by_id, import_batch_id } = args;
    const input = normalizeNewTypedFields(args.input);
    // Company Party/Role (ADR-0032) — an imported company is NOT roleless: it
    // gets the same bridge-derived CLIENT relationship as a legacy create (a
    // do_not_contact import row is rejected, same as the free create path).
    const relCreate = buildCreateRelationships(input, args.requestId);
    const row = await this.prisma.company.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        name: input.name,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        phone1: input.phone1 ?? null,
        phone2: input.phone2 ?? null,
        fax_number: input.fax_number ?? null,
        url: input.url ?? null,
        key_technologies: input.key_technologies ?? null,
        notes: input.notes ?? null,
        is_hot: input.is_hot ?? false,
        billing_contact_id: input.billing_contact_id ?? null,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
        import_batch_id,
        // Company-Fields v1.1 — un-gated additive columns. The import field-
        // mapping does not surface the commercial fields (a separate mapping
        // concern), so additiveCreateData writes null/default for them here —
        // no commercial bypass of the gate via import.
        ...additiveCreateData(input),
        relationships: { create: relCreate },
      },
      include: RELATIONSHIP_INCLUDE,
    });
    return projectView(row as CompanyRow);
  }

  // PR-A8-1 — import-engine reversion. deleteMany by the back-reference;
  // tenant-scoped at the row level (an admin in tenant A cannot revert
  // a batch in tenant B even if they hold the batch_id). Returns the
  // delete count for the audit log.
  async deleteByImportBatch(args: {
    tenant_id: string;
    import_batch_id: string;
  }): Promise<number> {
    const result = await this.prisma.company.deleteMany({
      where: {
        tenant_id: args.tenant_id,
        import_batch_id: args.import_batch_id,
      },
    });
    return result.count;
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<CompanyView | null> {
    const row = await this.prisma.company.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      include: RELATIONSHIP_INCLUDE,
    });
    return row === null ? null : projectView(row as CompanyRow);
  }

  async list(args: {
    tenant_id: string;
    site_id?: string;
    limit?: number;
  }): Promise<CompanyView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.company.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: RELATIONSHIP_INCLUDE,
    });
    return (rows as CompanyRow[]).map(projectView);
  }

  // Batch name resolution for cross-schema enrichment (e.g. the contact list
  // surfaces each contact's company display name from contact.company_id). One
  // set-based query over the id set, tenant-scoped — never per-row. Returns
  // company_id → name; ids not resolvable in-tenant are simply absent.
  async findNamesByIds(args: {
    tenant_id: string;
    ids: readonly string[];
  }): Promise<Map<string, string>> {
    if (args.ids.length === 0) return new Map();
    const rows = await this.prisma.company.findMany({
      where: { tenant_id: args.tenant_id, id: { in: [...args.ids] } },
      select: { id: true, name: true },
    });
    const out = new Map<string, string>();
    for (const r of rows as Array<{ id: string; name: string }>) {
      out.set(r.id, r.name);
    }
    return out;
  }

  // AUTHZ-D4b — visibility-scoped read paths. The cascade applies
  // `id IN visibility.visible_client_ids` (or unrestricted when
  // see_all_company). All queries are query-layer (DDR D6).
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visibility: VisibilityContextShape;
  }): Promise<CompanyView | null> {
    if (!args.visibility.see_all_company) {
      const visible = args.visibility.visible_client_ids;
      if (visible !== null && !visible.has(args.id)) return null;
    }
    return this.findById({ tenant_id: args.tenant_id, id: args.id });
  }

  async listForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
    // Search PR-1 — optional ILIKE-contains quick-search over `name`
    // (trimmed, non-empty when present; the controller gates ?q= on
    // company:search). Trigram-accelerated via the pg_trgm GIN index on
    // name. ANDed (sibling key) with the D4b visibility filter below —
    // NARROWS within the visible set, never widens.
    q?: string;
    limit?: number;
  }): Promise<CompanyView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      ...(args.q === undefined
        ? {}
        : { name: { contains: args.q, mode: 'insensitive' } }),
    };
    if (!args.visibility.see_all_company) {
      const visible = args.visibility.visible_client_ids;
      if (visible !== null) {
        where['id'] = { in: Array.from(visible) };
      }
    }
    const rows = await this.prisma.company.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      include: RELATIONSHIP_INCLUDE,
    });
    return (rows as CompanyRow[]).map(projectView);
  }

  // Phase 2 — native server-side faceted search + keyset pagination. The page
  // `items` are narrowed by the full selection set; the `facets` + `total` are
  // computed over the BASE where (scope + q) so the facet rail and segment
  // badges stay stable as filters toggle. D4b visibility applied in buildBaseWhere.
  async searchPaged(
    query: CompanySearchQuery,
    visibility: VisibilityContextShape,
  ): Promise<CompanySearchPage> {
    const pageSize = Math.min(query.page_size ?? 50, 200);
    const dir: SortDir = query.dir ?? 'desc';
    const baseWhere = buildBaseWhere(query, visibility);
    const itemWhere = buildSelectionWhere(baseWhere, query);
    const orderBy = buildCompanyOrderBy(query.sort ?? 'created_at', dir);

    const [rows, facets, total] = await Promise.all([
      this.prisma.company.findMany({
        where: itemWhere,
        orderBy,
        take: pageSize + 1,
        include: RELATIONSHIP_INCLUDE,
        ...(query.cursor != null && query.cursor !== ''
          ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 }
          : {}),
      }),
      this.computeFacets(baseWhere),
      this.prisma.company.count({ where: baseWhere }),
    ]);

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last !== undefined ? encodeCursor(last.id) : null;

    return {
      items: (pageRows as CompanyRow[]).map(projectView),
      next_cursor,
      facets,
      total,
    };
  }

  private async computeFacets(
    baseWhere: Record<string, unknown>,
  ): Promise<CompanyFacets> {
    // Company Party/Role (ADR-0032, VR5) — the tab counts (type) + in-tab
    // lifecycle counts (status) group over CompanyRelationship, filtered to the
    // relationships whose company is in the visible base set. type counts are
    // exact distinct-company counts (UNIQUE(company,type) → ≤1 row per type per
    // company). status counts are relationship-row counts (a multi-role company
    // contributes to each of its relationships' statuses) — acceptable for the
    // secondary in-tab pills; the tabs are the load-bearing axis.
    const relWhere = { company: { is: baseWhere } };
    const [typeG, statusG, tierG, industryG, hot, offLimits, exclusivity, quiet] =
      await Promise.all([
        this.prisma.companyRelationship.groupBy({
          by: ['type'],
          where: relWhere,
          _count: { _all: true },
        }),
        this.prisma.companyRelationship.groupBy({
          by: ['status'],
          where: relWhere,
          _count: { _all: true },
        }),
        this.prisma.company.groupBy({
          by: ['client_tier'],
          where: baseWhere,
          _count: { _all: true },
        }),
        this.prisma.company.groupBy({
          by: ['industry'],
          where: baseWhere,
          _count: { _all: true },
        }),
        this.prisma.company.count({ where: { ...baseWhere, is_hot: true } }),
        this.prisma.company.count({ where: { ...baseWhere, off_limits: true } }),
        this.prisma.company.count({
          where: { ...baseWhere, exclusivity: true },
        }),
        this.prisma.company.count({
          where: {
            ...baseWhere,
            OR: [
              { last_activity_at: null },
              { last_activity_at: { lt: quietCutoff() } },
            ],
          },
        }),
      ]);
    return {
      relationship_type: toCompanyBuckets(typeG as CompanyGroupRow[], 'type'),
      relationship_status: toCompanyBuckets(statusG as CompanyGroupRow[], 'status'),
      tier: toCompanyBuckets(tierG as CompanyGroupRow[], 'client_tier', {
        dropNullOrEmpty: true,
      }),
      industry: toCompanyBuckets(industryG as CompanyGroupRow[], 'industry', {
        dropNullOrEmpty: true,
      }),
      hot,
      off_limits: offLimits,
      exclusivity,
      quiet,
    };
  }

  // Company Party/Role (ADR-0032, R7) — the CLIENT-workflow invariant read.
  // True iff the company (in tenant) holds a CLIENT relationship. Backs the
  // requisition CompanyClientCheckPort adapter (a requisition's company must
  // be a CLIENT). Tenant-scoped; a cross-tenant company_id returns false.
  async hasClientRelationship(args: {
    tenant_id: string;
    company_id: string;
  }): Promise<boolean> {
    const count = await this.prisma.companyRelationship.count({
      where: {
        tenant_id: args.tenant_id,
        company_id: args.company_id,
        type: 'CLIENT',
      },
    });
    return count > 0;
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: {
    tenant_id: string;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.company.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateCompanyRequestDto;
    requestId: string;
    // Company-Fields v1.1 — actor scopes; commercial fields stripped from the
    // input when company:read_commercial is absent. Because update writes
    // present-keys-only, a stripped (now-absent) commercial field is NOT set,
    // so an existing commercial value is preserved (never nulled).
    scopes: readonly string[];
  }): Promise<CompanyView> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const input = normalizeNewTypedFields(
      stripUnscopedCommercialFields(args.input, args.scopes),
    );
    // Company Party/Role (ADR-0032) — nested relationship upserts (explicit
    // relationship-aware writes, or the A1 legacy status→CLIENT sync). Applied
    // atomically as part of the single company.update.
    const relUpserts = buildUpdateRelationshipUpserts(
      input,
      args.tenant_id,
      args.id,
    );
    const row = await this.prisma.company.update({
      where: { id: args.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.address2 === undefined ? {} : { address2: input.address2 }),
        ...(input.city === undefined ? {} : { city: input.city }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.zip === undefined ? {} : { zip: input.zip }),
        ...(input.phone1 === undefined ? {} : { phone1: input.phone1 }),
        ...(input.phone2 === undefined ? {} : { phone2: input.phone2 }),
        ...(input.fax_number === undefined ? {} : { fax_number: input.fax_number }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.key_technologies === undefined ? {} : { key_technologies: input.key_technologies }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.is_hot === undefined ? {} : { is_hot: input.is_hot }),
        ...(input.billing_contact_id === undefined ? {} : { billing_contact_id: input.billing_contact_id }),
        ...(input.owner_id === undefined ? {} : { owner_id: input.owner_id }),
        // Company-Fields v1.1 — un-gated additive (present-key-only; null clears).
        ...(input.status === undefined ? {} : { status: input.status }),
        // Company Party/Role (ADR-0032). master_status present-key-only. A
        // do_not_contact legacy status PATCH sets the restriction flag (§5)
        // unless the caller explicitly set communication_restricted.
        ...(input.master_status === undefined ? {} : { master_status: input.master_status }),
        ...(input.communication_restricted !== undefined
          ? { communication_restricted: input.communication_restricted }
          : input.status === 'do_not_contact'
            ? { communication_restricted: true }
            : {}),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.industry === undefined ? {} : { industry: input.industry }),
        ...(input.country === undefined ? {} : { country: input.country }),
        ...(input.employee_count_band === undefined ? {} : { employee_count_band: input.employee_count_band }),
        ...(input.annual_revenue_band === undefined ? {} : { annual_revenue_band: input.annual_revenue_band }),
        ...(input.founded_year === undefined ? {} : { founded_year: input.founded_year }),
        ...(input.ownership_type === undefined ? {} : { ownership_type: input.ownership_type }),
        ...(input.registration_number === undefined ? {} : { registration_number: input.registration_number }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.client_tier === undefined ? {} : { client_tier: input.client_tier }),
        ...(input.supplier_status === undefined ? {} : { supplier_status: input.supplier_status }),
        ...(input.exclusivity === undefined ? {} : { exclusivity: input.exclusivity }),
        ...(input.off_limits === undefined ? {} : { off_limits: input.off_limits }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.general_email === undefined ? {} : { general_email: input.general_email }),
        // Address-Autocomplete v1.0 — provider place reference (present-key-only;
        // null clears).
        ...(input.address_provider_place_id === undefined ? {} : { address_provider_place_id: input.address_provider_place_id }),
        ...(input.address_provider === undefined ? {} : { address_provider: input.address_provider }),
        // Company-Fields v1.1 — gated commercial (absent after strip for
        // non-holders → not set → existing value preserved).
        ...(input.fee_model === undefined ? {} : { fee_model: input.fee_model }),
        ...(input.default_contract_markup_pct === undefined ? {} : { default_contract_markup_pct: input.default_contract_markup_pct }),
        ...(input.default_perm_fee_pct === undefined ? {} : { default_perm_fee_pct: input.default_perm_fee_pct }),
        ...(input.payment_terms === undefined ? {} : { payment_terms: input.payment_terms }),
        ...(input.credit_status === undefined ? {} : { credit_status: input.credit_status }),
        ...(input.default_currency === undefined ? {} : { default_currency: input.default_currency }),
        ...(relUpserts.length > 0 ? { relationships: { upsert: relUpserts } } : {}),
      },
      include: RELATIONSHIP_INCLUDE,
    });
    return projectView(row as CompanyRow);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.company.delete({ where: { id: args.id } });
  }
}
