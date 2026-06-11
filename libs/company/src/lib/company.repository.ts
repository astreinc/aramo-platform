import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';

import type { CompanyView } from './dto/company.view.js';
import { stripUnscopedCommercialFields } from './commercial-write-strip.js';
import type { CreateCompanyRequestDto } from './dto/create-company-request.dto.js';
import type { UpdateCompanyRequestDto } from './dto/update-company-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Decimal columns (default_contract_markup_pct / default_perm_fee_pct) come
// back from Prisma as a Decimal instance; projected to string on the wire
// (no float drift — the compensation pattern). Typed structurally so the
// repo needn't import the generated Prisma.Decimal.
type DecimalLike = { toString(): string };

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
  tags: string[];
  general_email: string | null;
  last_activity_at: Date | null;
  next_action_at: Date | null;
  // Company-Fields v1.1 — gated commercial (Decimal cols as DecimalLike).
  fee_model: string | null;
  default_contract_markup_pct: DecimalLike | null;
  default_perm_fee_pct: DecimalLike | null;
  payment_terms: string | null;
  credit_status: string | null;
  default_currency: string | null;
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
    tags: row.tags,
    general_email: row.general_email,
    last_activity_at:
      row.last_activity_at !== null ? row.last_activity_at.toISOString() : null,
    next_action_at:
      row.next_action_at !== null ? row.next_action_at.toISOString() : null,
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
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.exclusivity === undefined ? {} : { exclusivity: input.exclusivity }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.default_currency === undefined
      ? {}
      : { default_currency: input.default_currency }),
  };
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
  }): Promise<CompanyView> {
    const { tenant_id, entered_by_id } = args;
    const input = normalizeNewTypedFields(
      stripUnscopedCommercialFields(args.input, args.scopes),
    );
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
      },
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
  }): Promise<CompanyView> {
    const { tenant_id, entered_by_id, import_batch_id } = args;
    const input = normalizeNewTypedFields(args.input);
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
      },
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
    });
    return (rows as CompanyRow[]).map(projectView);
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
    });
    return (rows as CompanyRow[]).map(projectView);
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
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.general_email === undefined ? {} : { general_email: input.general_email }),
        // Company-Fields v1.1 — gated commercial (absent after strip for
        // non-holders → not set → existing value preserved).
        ...(input.fee_model === undefined ? {} : { fee_model: input.fee_model }),
        ...(input.default_contract_markup_pct === undefined ? {} : { default_contract_markup_pct: input.default_contract_markup_pct }),
        ...(input.default_perm_fee_pct === undefined ? {} : { default_perm_fee_pct: input.default_perm_fee_pct }),
        ...(input.payment_terms === undefined ? {} : { payment_terms: input.payment_terms }),
        ...(input.credit_status === undefined ? {} : { credit_status: input.credit_status }),
        ...(input.default_currency === undefined ? {} : { default_currency: input.default_currency }),
      },
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
