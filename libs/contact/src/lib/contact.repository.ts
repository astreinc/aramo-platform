import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';
import { CompanyDepartmentRepository, CompanyRepository } from '@aramo/company';

import type { ContactView } from './dto/contact.view.js';
import type { CreateContactRequestDto } from './dto/create-contact-request.dto.js';
import type { UpdateContactRequestDto } from './dto/update-contact-request.dto.js';
import type {
  ContactFacetBucket,
  ContactFacets,
  ContactSearchPage,
  ContactSearchQuery,
  ContactSortKey,
  SortDir,
} from './dto/contact-search.dto.js';
import { QUIET_DAYS } from './dto/contact-search.dto.js';
import { assertContactVocab } from './dto/contact-vocab.js';
import { PrismaService } from './prisma/prisma.service.js';
import {
  CONTACT_AUDIT_SINK,
  CONTACT_OWNER_VALIDATOR,
  type ContactAuditSink,
  type ContactOwnerValidator,
} from './contact-owner-validator.port.js';

// ContactRepository — write + read surface for Contact. Reference-CRUD
// per Ruling 7 (no metering, no event log, no state machine).
//
// Cross-lib edge: contact -> company (the contact -> company leaf-import
// per Ruling 1). At create + update we validate company_id resolves
// within the caller's tenant via CompanyRepository.findById. The reverse
// (company -> contact for billing_contact_id) is NOT a typed link —
// resolved at read-time via UUID only — preserving the no-cycle invariant.

interface ContactRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  company_id: string;
  company_department_id: string | null;
  first_name: string;
  last_name: string;
  title: string | null;
  email1: string | null;
  email2: string | null;
  phone_work: string | null;
  phone_cell: string | null;
  phone_other: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  is_hot: boolean;
  notes: string | null;
  left_company: boolean;
  is_primary: boolean;
  reports_to_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  relationship_role: string | null;
  preference: string | null;
  last_activity_at: Date | null;
  contact_kind: string | null;
  deleted_at: Date | null;
  deleted_by_id: string | null;
}

// company_name + relationship_types are read-time enrichment (cross-schema,
// UUID-only resolution), not Contact columns — filled by the caller from batch
// CompanyRepository lookups (findNamesByIds / findRelationshipTypesByIds).
function projectView(
  row: ContactRow,
  companyName: string | null = null,
  relationshipTypes: string[] = [],
): ContactView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    company_id: row.company_id,
    company_department_id: row.company_department_id,
    first_name: row.first_name,
    last_name: row.last_name,
    title: row.title,
    email1: row.email1,
    email2: row.email2,
    phone_work: row.phone_work,
    phone_cell: row.phone_cell,
    phone_other: row.phone_other,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    is_hot: row.is_hot,
    notes: row.notes,
    left_company: row.left_company,
    is_primary: row.is_primary,
    reports_to_id: row.reports_to_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    relationship_role: row.relationship_role,
    preference: row.preference,
    last_activity_at:
      row.last_activity_at !== null ? row.last_activity_at.toISOString() : null,
    contact_kind: row.contact_kind ?? null,
    deleted_at: row.deleted_at != null ? row.deleted_at.toISOString() : null,
    deleted_by_id: row.deleted_by_id ?? null,
    company_name: companyName,
    relationship_types: relationshipTypes,
  };
}

// ── Contact-spec amendment v1.0 — server-side faceted search helpers ──
// Mirrors libs/company's searchPaged helpers exactly (single-schema).

// Opaque keyset cursor = the last row id (base64url). Correctness comes from the
// deterministic orderBy (sort col(s) + id tiebreak) + Prisma cursor/skip.
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

function quietCutoff(): Date {
  return new Date(Date.now() - QUIET_DAYS * 86_400_000);
}

// Each sort ends with `id` so the keyset is total-ordered (no skips/dupes).
// The cold-call queue sorts by last_activity ascending with nulls FIRST — a
// never-contacted person is the most overdue, so they lead the queue.
function buildContactOrderBy(
  sort: ContactSortKey,
  dir: SortDir,
): Array<Record<string, unknown>> {
  switch (sort) {
    case 'name':
      return [{ last_name: dir }, { first_name: dir }, { id: dir }];
    case 'last_activity':
      return dir === 'asc'
        ? [{ last_activity_at: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }]
        : [{ last_activity_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
    case 'created_at':
      return [{ created_at: dir }, { id: dir }];
  }
}

// "Callable" = preference is NOT do_not_contact (null displays/stores as
// contactable → callable) AND a non-empty work phone is on file. Returned as a
// single AND-clause so it composes with the other compound predicates without
// clobbering the top-level OR (name search) or quiet OR.
function coldCallableClause(): Record<string, unknown> {
  return {
    AND: [
      {
        OR: [
          { preference: null },
          { preference: { in: ['contactable', 'limited'] } },
        ],
      },
      { phone_work: { not: null } },
      { phone_work: { not: '' } },
    ],
  };
}

// The BASE where — tenant + site + name-search + owner scope + former-exclusion
// + cold-callable + D4b visibility. Facet counts and `total` are computed over
// THIS (selection-independent). former (left_company) rows are EXCLUDED unless
// the `former` filter is explicitly set (matches the mockup default).
//
// Every compound predicate (name OR, cold-callable) is pushed into an AND
// accumulator so they intersect cleanly rather than overwriting one another.
function buildBaseWhere(
  q: ContactSearchQuery,
  visibility: VisibilityContextShape,
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    tenant_id: q.tenant_id,
    // CONTACTS-1 §5 — the deleted view (SD-9) shows ONLY soft-deleted rows;
    // every other read excludes them (SD-3).
    deleted_at: q.deleted === true ? { not: null } : null,
  };
  const and: Record<string, unknown>[] = [];
  if (q.site_id !== undefined) where['site_id'] = q.site_id;
  if (q.q !== undefined && q.q !== '') {
    and.push({
      OR: [
        { first_name: { contains: q.q, mode: 'insensitive' } },
        { last_name: { contains: q.q, mode: 'insensitive' } },
      ],
    });
  }
  if (q.owner_id !== undefined) where['owner_id'] = q.owner_id;
  // former rows are excluded from the base unless the Former segment is
  // selected; the selection then narrows to ONLY former rows (CONTACTS-1 F-1),
  // so the list matches the segment's `former` badge.
  if (q.former !== true && q.deleted !== true) where['left_company'] = false;
  if (q.cold_callable === true) and.push(coldCallableClause());
  if (!visibility.see_all_company) {
    const visible = visibility.visible_client_ids;
    if (visible !== null) where['company_id'] = { in: Array.from(visible) };
  }
  if (and.length > 0) where['AND'] = and;
  return where;
}

// The selection where = base + the relationship_role/preference/company/flag
// picks. relationship_role / preference / is_hot are distinct scalar keys (safe
// to set directly). The company facet and the quiet OR go into the AND
// accumulator so they INTERSECT with the base visibility company_id and the
// base name OR — never widen past the visible set.
function buildSelectionWhere(
  base: Record<string, unknown>,
  q: ContactSearchQuery,
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...base };
  const and: Record<string, unknown>[] = Array.isArray(where['AND'])
    ? [...(where['AND'] as Record<string, unknown>[])]
    : [];
  if (q.relationship_role !== undefined && q.relationship_role.length > 0)
    where['relationship_role'] = { in: [...q.relationship_role] };
  if (q.preference !== undefined && q.preference.length > 0)
    where['preference'] = { in: [...q.preference] };
  if (q.company_id !== undefined && q.company_id.length > 0)
    and.push({ company_id: { in: [...q.company_id] } });
  if (q.is_hot === true) where['is_hot'] = true;
  // Primary-contact filter (companies-list "Primary contact" column) — one
  // primary per company; combined with company_id[] it returns the page's
  // primaries in a single visibility-scoped read.
  if (q.is_primary === true) where['is_primary'] = true;
  if (q.former === true) where['left_company'] = true;
  if (q.quiet === true) {
    and.push({
      OR: [
        { last_activity_at: null },
        { last_activity_at: { lt: quietCutoff() } },
      ],
    });
  }
  if (and.length > 0) where['AND'] = and;
  return where;
}

// Enterprise Search (GS-1) — the lean projection the search adapter maps to a SearchHit.
// DELIBERATELY excludes email/phone: a generic search hit must never become a way to expose
// contact channels, even when a channel was internally matched for retrieval.
const CONTACT_SEARCH_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  title: true,
  company_id: true,
} as const;

export interface ContactSearchRow {
  id: string;
  first_name: string;
  last_name: string;
  title: string | null;
  company_id: string;
}

interface ContactGroupRow {
  readonly _count: { readonly _all: number };
  readonly [key: string]: unknown;
}

function toContactBuckets(
  rows: readonly ContactGroupRow[],
  key: string,
): ContactFacetBucket[] {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    if (
      raw === null ||
      raw === undefined ||
      (typeof raw === 'string' && raw.trim() === '')
    ) {
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
export class ContactRepository {
  private readonly logger = new Logger(ContactRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyRepository: CompanyRepository,
    private readonly departmentRepository: CompanyDepartmentRepository,
    @Optional()
    @Inject(CONTACT_OWNER_VALIDATOR)
    private readonly ownerValidator?: ContactOwnerValidator,
    @Optional()
    @Inject(CONTACT_AUDIT_SINK)
    private readonly auditSink?: ContactAuditSink,
  ) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateContactRequestDto;
    requestId: string;
  }): Promise<ContactView> {
    // Closed-vocab guard (the @IsIn contract, app-layer) — 400 before any write.
    assertContactVocab(args.input, args.requestId);
    // CONTACTS-1 V-3 — in-tenant reference checks (department, reports-to, owner).
    await this.assertReferences({
      tenant_id: args.tenant_id,
      company_id: args.input.company_id,
      self_id: null,
      company_department_id: args.input.company_department_id,
      reports_to_id: args.input.reports_to_id,
      owner_id: args.input.owner_id,
      requestId: args.requestId,
    });
    // Cross-schema company_id validation — same tenant (Architecture §7.2).
    // Logical UUID resolution; no FK constraint at the DB layer (§7.3).
    const parent = await this.companyRepository.findById({
      tenant_id: args.tenant_id,
      id: args.input.company_id,
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { company_id: args.input.company_id },
        },
      );
    }

    const data = {
      tenant_id: args.tenant_id,
      site_id: args.input.site_id ?? null,
      company_id: args.input.company_id,
      company_department_id: args.input.company_department_id ?? null,
      first_name: args.input.first_name,
      last_name: args.input.last_name,
      title: args.input.title ?? null,
      email1: args.input.email1 ?? null,
      email2: args.input.email2 ?? null,
      phone_work: args.input.phone_work ?? null,
      phone_cell: args.input.phone_cell ?? null,
      phone_other: args.input.phone_other ?? null,
      address: args.input.address ?? null,
      address2: args.input.address2 ?? null,
      city: args.input.city ?? null,
      state: args.input.state ?? null,
      zip: args.input.zip ?? null,
      is_hot: args.input.is_hot ?? false,
      notes: args.input.notes ?? null,
      is_primary: args.input.is_primary ?? false,
      reports_to_id: args.input.reports_to_id ?? null,
      owner_id: args.input.owner_id ?? args.entered_by_id,
      entered_by_id: args.entered_by_id,
      relationship_role: args.input.relationship_role ?? null,
      preference: args.input.preference ?? null,
      contact_kind: args.input.contact_kind ?? null,
    };
    // Primary invariant — at most one primary per (tenant, company). When this
    // create claims primary, demote any prior primary in the SAME transaction
    // (nicer than surfacing the partial-unique-index P2002 to the caller); the
    // index remains the hard backstop against races.
    const row =
      data.is_primary === true
        ? await this.prisma.$transaction(async (tx) => {
            // Demote any prior primary for this company (nicer than surfacing
            // the partial-unique-index P2002); the index is the hard backstop.
            await tx.contact.updateMany({
              where: {
                tenant_id: args.tenant_id,
                company_id: data.company_id,
                is_primary: true,
              },
              data: { is_primary: false },
            });
            return tx.contact.create({ data });
          })
        : await this.prisma.contact.create({ data });
    return projectView(row as ContactRow);
  }

  // PR-A8-1 — import-engine create. Mirrors create() including the
  // cross-schema company_id in-tenant validation (Architecture §7.2);
  // attributes the row to the import batch for reversion.
  async createForImport(args: {
    tenant_id: string;
    entered_by_id: string;
    import_batch_id: string;
    input: CreateContactRequestDto;
    requestId: string;
  }): Promise<ContactView> {
    assertContactVocab(args.input, args.requestId);
    const parent = await this.companyRepository.findById({
      tenant_id: args.tenant_id,
      id: args.input.company_id,
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { company_id: args.input.company_id },
        },
      );
    }

    const row = await this.prisma.contact.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        company_id: args.input.company_id,
        company_department_id: args.input.company_department_id ?? null,
        first_name: args.input.first_name,
        last_name: args.input.last_name,
        title: args.input.title ?? null,
        email1: args.input.email1 ?? null,
        email2: args.input.email2 ?? null,
        phone_work: args.input.phone_work ?? null,
        phone_cell: args.input.phone_cell ?? null,
        phone_other: args.input.phone_other ?? null,
        address: args.input.address ?? null,
        address2: args.input.address2 ?? null,
        city: args.input.city ?? null,
        state: args.input.state ?? null,
        zip: args.input.zip ?? null,
        is_hot: args.input.is_hot ?? false,
        notes: args.input.notes ?? null,
        reports_to_id: args.input.reports_to_id ?? null,
        owner_id: args.input.owner_id ?? args.entered_by_id,
        entered_by_id: args.entered_by_id,
        import_batch_id: args.import_batch_id,
        relationship_role: args.input.relationship_role ?? null,
        preference: args.input.preference ?? null,
        contact_kind: args.input.contact_kind ?? null,
      },
    });
    return projectView(row as ContactRow);
  }

  // PR-A8-1 — import-engine reversion, by the import_batch_id back-reference.
  // CONTACTS-1 SD-10 — a SOFT delete like every other contact removal (no
  // hard-delete path remains): the batch's live rows are marked deleted and
  // lose any primary flag. Returns the number of rows marked.
  async deleteByImportBatch(args: {
    tenant_id: string;
    import_batch_id: string;
    deleted_by_id?: string | null;
  }): Promise<number> {
    const result = await this.prisma.contact.updateMany({
      where: {
        tenant_id: args.tenant_id,
        import_batch_id: args.import_batch_id,
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        deleted_by_id: args.deleted_by_id ?? null,
        is_primary: false,
      },
    });
    return result.count;
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ContactView | null> {
    const row = await this.prisma.contact.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as ContactRow);
  }

  async list(args: {
    tenant_id: string;
    company_id?: string;
    site_id?: string;
    limit?: number;
  }): Promise<ContactView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.contact.findMany({
      where: {
        tenant_id: args.tenant_id,
        deleted_at: null,
        ...(args.company_id === undefined ? {} : { company_id: args.company_id }),
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as ContactRow[]).map((r) => projectView(r));
  }

  // Enterprise Search (GS-1) — lean, VISIBILITY-AWARE search leg for the search adapter.
  // Consumes the RESOLVED contact visibility exactly as the visibility-scoped reads do
  // (company_id ∈ visible_client_ids unless see_all_company) — it applies resolved authority,
  // it does not recreate a rule. Matches first_name OR last_name OR title (mirrors the domain
  // read's name lexical, plus title). The visibility filter uses `company_id: { in }` (no OR),
  // so the text OR sits at top level without collision. Lean select → the hit never carries
  // email/phone.
  async searchLexicalForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
    q: string;
    limit?: number;
  }): Promise<ContactSearchRow[]> {
    const q = args.q.trim();
    if (q === '') return [];
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      deleted_at: null,
      ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      OR: [
        { first_name: { contains: q, mode: 'insensitive' } },
        { last_name: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (!args.visibility.see_all_company) {
      const visible = args.visibility.visible_client_ids;
      if (visible !== null) where['company_id'] = { in: Array.from(visible) };
    }
    const rows = await this.prisma.contact.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      select: CONTACT_SEARCH_SELECT,
    });
    return rows as ContactSearchRow[];
  }

  // AUTHZ-D4b — visibility-scoped read paths. Contact's visibility is
  // direct: contact.company_id ∈ visibility.visible_client_ids. The
  // see_all_company short-circuit (TA + TO per D4a §6) drops the filter.
  // CONTACTS-1 SD-4/SD-5 — a soft-deleted contact reads as not-found unless the
  // caller asks for it (include_deleted: the "Name (Deleted)" display on a
  // screen that still references it). Visibility applies either way.
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visibility: VisibilityContextShape;
    include_deleted?: boolean;
  }): Promise<ContactView | null> {
    const row = await this.prisma.contact.findFirst({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        ...(args.include_deleted === true ? {} : { deleted_at: null }),
      },
    });
    if (row === null) return null;
    if (!args.visibility.see_all_company) {
      const visible = args.visibility.visible_client_ids;
      if (visible !== null && !visible.has((row as ContactRow).company_id)) {
        return null;
      }
    }
    // Detail enrichment — resolve the company display name + relationship
    // type(s) (cross-schema, batched even for the single id).
    const cid = (row as ContactRow).company_id;
    const [names, relTypes] = await Promise.all([
      this.companyRepository.findNamesByIds({ tenant_id: args.tenant_id, ids: [cid] }),
      this.companyRepository.findRelationshipTypesByIds({
        tenant_id: args.tenant_id,
        ids: [cid],
      }),
    ]);
    return projectView(
      row as ContactRow,
      names.get(cid) ?? null,
      relTypes.get(cid) ?? [],
    );
  }

  async listForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    company_id?: string;
    site_id?: string;
    // Search PR-1 — optional ILIKE-contains quick-search over
    // first_name/last_name (trimmed, non-empty when present; the controller
    // gates ?q= on contact:search). Trigram-accelerated via the pg_trgm GIN
    // indexes on first_name / last_name. The OR is a sibling key ANDed with
    // the D4b visibility filter (which keys on `company_id`, not OR — no
    // collision) — NARROWS within the visible set.
    q?: string;
    limit?: number;
  }): Promise<ContactView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      deleted_at: null,
      ...(args.company_id === undefined ? {} : { company_id: args.company_id }),
      ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      ...(args.q === undefined
        ? {}
        : {
            OR: [
              { first_name: { contains: args.q, mode: 'insensitive' } },
              { last_name: { contains: args.q, mode: 'insensitive' } },
            ],
          }),
    };
    if (!args.visibility.see_all_company) {
      const visible = args.visibility.visible_client_ids;
      if (visible !== null) {
        // Compose with any caller-supplied company_id narrowing: if the
        // narrow target is NOT in the visible set, the actor cannot see
        // any of its contacts → return [] without a DB call.
        if (args.company_id !== undefined && !visible.has(args.company_id)) {
          return [];
        }
        if (args.company_id === undefined) {
          where['company_id'] = { in: Array.from(visible) };
        }
      }
    }
    const rows = await this.prisma.contact.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    // Relationship-type enrichment (cross-schema, batched over the id set).
    const relTypes = await this.companyRepository.findRelationshipTypesByIds({
      tenant_id: args.tenant_id,
      ids: [...new Set((rows as ContactRow[]).map((r) => r.company_id))],
    });
    return (rows as ContactRow[]).map((r) =>
      projectView(r, null, relTypes.get(r.company_id) ?? []),
    );
  }

  // Contact-spec amendment v1.0 — native server-side faceted search + keyset
  // pagination. Mirrors company.searchPaged EXACTLY. The page `items` are
  // narrowed by the full selection set; `facets` + `total` are computed over the
  // BASE where (scope + q + visibility + former/cold-callable) so the facet rail
  // and segment badges stay stable as filters toggle. The "My contacts" scope is
  // a SERVER-ENFORCED owner_id predicate in buildBaseWhere (q.owner_id, derived
  // from the JWT by the controller) — never a client filter over an all-contacts
  // payload. D4b visibility (company_id ∈ visible_client_ids) applies alongside.
  async searchPaged(
    query: ContactSearchQuery,
    visibility: VisibilityContextShape,
  ): Promise<ContactSearchPage> {
    const pageSize = Math.min(query.page_size ?? 50, 200);
    const dir: SortDir = query.dir ?? 'desc';
    const baseWhere = buildBaseWhere(query, visibility);
    const itemWhere = buildSelectionWhere(baseWhere, query);
    const orderBy = buildContactOrderBy(query.sort ?? 'created_at', dir);

    const [rows, facets, total] = await Promise.all([
      this.prisma.contact.findMany({
        where: itemWhere,
        orderBy,
        take: pageSize + 1,
        ...(query.cursor != null && query.cursor !== ''
          ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 }
          : {}),
      }),
      this.computeFacets(baseWhere),
      this.prisma.contact.count({ where: baseWhere }),
    ]);

    const hasMore = rows.length > pageSize;
    const pageRows = (hasMore ? rows.slice(0, pageSize) : rows) as ContactRow[];
    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last !== undefined ? encodeCursor(last.id) : null;

    // Cross-schema enrichment — batch-resolve each row's company display name +
    // relationship type(s) (one query each over the page's distinct company_ids).
    const ids = [...new Set(pageRows.map((r) => r.company_id))];
    const [names, relTypes] = await Promise.all([
      this.companyRepository.findNamesByIds({ tenant_id: query.tenant_id, ids }),
      this.companyRepository.findRelationshipTypesByIds({
        tenant_id: query.tenant_id,
        ids,
      }),
    ]);

    return {
      items: pageRows.map((r) =>
        projectView(
          r,
          names.get(r.company_id) ?? null,
          relTypes.get(r.company_id) ?? [],
        ),
      ),
      next_cursor,
      facets,
      total,
    };
  }

  private async computeFacets(
    baseWhere: Record<string, unknown>,
  ): Promise<ContactFacets> {
    const [roleG, prefG, companyG, hot, quiet, former, primary] = await Promise.all([
      this.prisma.contact.groupBy({
        by: ['relationship_role'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.contact.groupBy({
        by: ['preference'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.contact.groupBy({
        by: ['company_id'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.contact.count({ where: { ...baseWhere, is_hot: true } }),
      this.prisma.contact.count({
        where: {
          ...baseWhere,
          OR: [
            { last_activity_at: null },
            { last_activity_at: { lt: quietCutoff() } },
          ],
        },
      }),
      this.prisma.contact.count({
        where: { ...baseWhere, left_company: true },
      }),
      // CONTACTS-1 F-4 — the headline primary count over the whole visible
      // set (was counted client-side from the loaded page only).
      this.prisma.contact.count({
        where: { ...baseWhere, is_primary: true },
      }),
    ]);
    return {
      relationship_role: toContactBuckets(
        roleG as ContactGroupRow[],
        'relationship_role',
      ),
      preference: toContactBuckets(prefG as ContactGroupRow[], 'preference'),
      company: toContactBuckets(companyG as ContactGroupRow[], 'company_id'),
      hot,
      quiet,
      former,
      primary,
    };
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: {
    tenant_id: string;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.contact.count({
      where: {
        tenant_id: args.tenant_id,
        deleted_at: null,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  // Tasks backend — the contact visible-id set (consumed by libs/visibility's
  // resolveVisibleContactIds for the polymorphic Task visibility). LIFTS the
  // existing contact-visibility rule (contact.company_id ∈ visible_client_ids)
  // to an id-set read — it does NOT reinvent it. Returns contact ids whose
  // company is in the given visible-company set, tenant-scoped (query-layer;
  // no fetch-then-filter). Empty company set → []. The see-all case is handled
  // by the resolver (returns null before calling this).
  async findContactIdsForCompanies(args: {
    tenant_id: string;
    company_ids: readonly string[];
  }): Promise<string[]> {
    if (args.company_ids.length === 0) return [];
    const rows = await this.prisma.contact.findMany({
      where: {
        tenant_id: args.tenant_id,
        company_id: { in: Array.from(args.company_ids) },
      },
      select: { id: true },
    });
    return (rows as Array<{ id: string }>).map((r) => r.id);
  }

  // CONTACTS-1 W-1 — the write paths resolve the SAME visibility as the reads:
  // a contact outside the actor's visible companies is NOT_FOUND (identical to
  // the invisible read). Structural: every mutation REQUIRES the resolved
  // visibility. A soft-deleted contact is also NOT_FOUND here (SD-7).
  private async loadWritable(args: {
    tenant_id: string;
    id: string;
    visibility: VisibilityContextShape;
    requestId: string;
    deleted: boolean;
  }): Promise<ContactRow> {
    const row = (await this.prisma.contact.findFirst({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        deleted_at: args.deleted ? { not: null } : null,
      },
    })) as ContactRow | null;
    const visible =
      row !== null &&
      (args.visibility.see_all_company ||
        args.visibility.visible_client_ids === null ||
        args.visibility.visible_client_ids.has(row.company_id));
    if (row === null || !visible) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    return row;
  }

  // CONTACTS-1 V-3 — in-tenant checks for the cross-row references a contact
  // carries. company_department_id must belong to the contact's company;
  // reports_to_id must be another LIVE contact at the same company; owner_id
  // must be an assignable tenant member (port, bound in apps/api).
  private async assertReferences(args: {
    tenant_id: string;
    company_id: string;
    self_id: string | null;
    company_department_id?: string | null;
    reports_to_id?: string | null;
    owner_id?: string | null;
    requestId: string;
  }): Promise<void> {
    if (args.company_department_id != null) {
      const departments = await this.departmentRepository.list({
        tenant_id: args.tenant_id,
        company_id: args.company_id,
      });
      if (!departments.some((d) => d.id === args.company_department_id)) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'company_department_id is not a department of the contact\'s company',
          422,
          {
            requestId: args.requestId,
            details: {
              field: 'company_department_id',
              reason: 'department_company_mismatch',
            },
          },
        );
      }
    }
    if (args.reports_to_id != null) {
      if (args.reports_to_id === args.self_id) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'A contact cannot report to itself',
          422,
          {
            requestId: args.requestId,
            details: { field: 'reports_to_id', reason: 'self_reference' },
          },
        );
      }
      await this.assertLinkable({
        tenant_id: args.tenant_id,
        id: args.reports_to_id,
        company_id: args.company_id,
        requestId: args.requestId,
        field: 'reports_to_id',
      });
    }
    if (args.owner_id != null && this.ownerValidator !== undefined) {
      await this.ownerValidator.assertAssignable({
        tenant_id: args.tenant_id,
        user_id: args.owner_id,
        requestId: args.requestId,
        field: 'owner_id',
      });
    }
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateContactRequestDto;
    requestId: string;
    visibility: VisibilityContextShape;
  }): Promise<ContactView> {
    assertContactVocab(args.input, args.requestId);
    const existing = await this.loadWritable({
      tenant_id: args.tenant_id,
      id: args.id,
      visibility: args.visibility,
      requestId: args.requestId,
      deleted: false,
    });
    // Only references that CHANGE are re-checked: an unchanged link is not a
    // new link (SD-6), and editing another field must not fail because a
    // referenced contact was deleted later.
    const changed = <K extends 'company_department_id' | 'reports_to_id' | 'owner_id'>(
      k: K,
    ): string | null | undefined =>
      args.input[k] === undefined || args.input[k] === existing[k]
        ? undefined
        : args.input[k];
    await this.assertReferences({
      tenant_id: args.tenant_id,
      company_id: existing.company_id,
      self_id: existing.id,
      company_department_id: changed('company_department_id'),
      reports_to_id: changed('reports_to_id'),
      owner_id: changed('owner_id'),
      requestId: args.requestId,
    });
    const data = {
      ...(args.input.relationship_role === undefined ? {} : { relationship_role: args.input.relationship_role }),
      ...(args.input.preference === undefined ? {} : { preference: args.input.preference }),
      ...(args.input.contact_kind === undefined ? {} : { contact_kind: args.input.contact_kind }),
      ...(args.input.company_department_id === undefined ? {} : { company_department_id: args.input.company_department_id }),
      ...(args.input.first_name === undefined ? {} : { first_name: args.input.first_name }),
      ...(args.input.last_name === undefined ? {} : { last_name: args.input.last_name }),
      ...(args.input.title === undefined ? {} : { title: args.input.title }),
      ...(args.input.email1 === undefined ? {} : { email1: args.input.email1 }),
      ...(args.input.email2 === undefined ? {} : { email2: args.input.email2 }),
      ...(args.input.phone_work === undefined ? {} : { phone_work: args.input.phone_work }),
      ...(args.input.phone_cell === undefined ? {} : { phone_cell: args.input.phone_cell }),
      ...(args.input.phone_other === undefined ? {} : { phone_other: args.input.phone_other }),
      ...(args.input.address === undefined ? {} : { address: args.input.address }),
      ...(args.input.address2 === undefined ? {} : { address2: args.input.address2 }),
      ...(args.input.city === undefined ? {} : { city: args.input.city }),
      ...(args.input.state === undefined ? {} : { state: args.input.state }),
      ...(args.input.zip === undefined ? {} : { zip: args.input.zip }),
      ...(args.input.is_hot === undefined ? {} : { is_hot: args.input.is_hot }),
      ...(args.input.notes === undefined ? {} : { notes: args.input.notes }),
      ...(args.input.left_company === undefined ? {} : { left_company: args.input.left_company }),
      ...(args.input.is_primary === undefined ? {} : { is_primary: args.input.is_primary }),
      ...(args.input.reports_to_id === undefined ? {} : { reports_to_id: args.input.reports_to_id }),
      ...(args.input.owner_id === undefined ? {} : { owner_id: args.input.owner_id }),
    };
    // Primary invariant — promoting THIS contact demotes any prior primary for
    // its company in the same transaction (company_id is immutable, taken from
    // the existing row). Demotion (is_primary:false) needs no transaction.
    const row =
      args.input.is_primary === true
        ? await this.prisma.$transaction(async (tx) => {
            await tx.contact.updateMany({
              where: {
                tenant_id: args.tenant_id,
                company_id: existing.company_id,
                is_primary: true,
                id: { not: args.id },
              },
              data: { is_primary: false },
            });
            return tx.contact.update({ where: { id: args.id }, data });
          })
        : await this.prisma.contact.update({ where: { id: args.id }, data });
    return projectView(row as ContactRow);
  }

  // CONTACTS-1 SD-1/SD-2 — DELETE is a SOFT delete: the row is kept (existing
  // references stay resolvable, SD-5), marked deleted, and loses its primary
  // flag so the company can promote another primary.
  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
    visibility: VisibilityContextShape;
    actor_id: string;
  }): Promise<void> {
    const existing = await this.loadWritable({
      tenant_id: args.tenant_id,
      id: args.id,
      visibility: args.visibility,
      requestId: args.requestId,
      deleted: false,
    });
    await this.prisma.contact.update({
      where: { id: args.id },
      data: {
        deleted_at: new Date(),
        deleted_by_id: args.actor_id,
        is_primary: false,
      },
    });
    await this.auditSink?.record({
      event: 'deleted',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      contact_id: args.id,
      company_id: existing.company_id,
    });
  }

  // CONTACTS-1 SD-8 — restore clears the soft delete. A live (not deleted)
  // contact is a 200 no-op. Never re-promotes primary.
  async restore(args: {
    tenant_id: string;
    id: string;
    requestId: string;
    visibility: VisibilityContextShape;
    actor_id: string;
  }): Promise<ContactView> {
    const live = await this.prisma.contact.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id, deleted_at: null },
    });
    if (live !== null) {
      const view = await this.findByIdForActor({
        tenant_id: args.tenant_id,
        id: args.id,
        visibility: args.visibility,
      });
      if (view === null) {
        throw new AramoError(
          'NOT_FOUND',
          'Contact not found in tenant (or not visible to actor)',
          404,
          { requestId: args.requestId, details: { id: args.id } },
        );
      }
      return view;
    }
    const deleted = await this.loadWritable({
      tenant_id: args.tenant_id,
      id: args.id,
      visibility: args.visibility,
      requestId: args.requestId,
      deleted: true,
    });
    await this.prisma.contact.update({
      where: { id: args.id },
      data: { deleted_at: null, deleted_by_id: null },
    });
    await this.auditSink?.record({
      event: 'restored',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      contact_id: args.id,
      company_id: deleted.company_id,
    });
    const view = await this.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.id,
      visibility: args.visibility,
    });
    return view as ContactView;
  }

  // CONTACTS-1 SD-6 — the single "may this contact be the target of a NEW
  // link?" check, used by every linking surface (requisition hiring manager,
  // company billing contact, task owner, saved list, reports-to, activity).
  // Not in tenant → VALIDATION_ERROR contact_not_found; at another company
  // (when company_id is given) → VALIDATION_ERROR contact_company_mismatch;
  // soft-deleted → CONTACT_DELETED. All 422.
  async assertLinkable(args: {
    tenant_id: string;
    id: string;
    company_id?: string;
    requestId: string;
    field: string;
  }): Promise<void> {
    const row = (await this.prisma.contact.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true, company_id: true, deleted_at: true },
    })) as { id: string; company_id: string; deleted_at: Date | null } | null;
    if (row === null) {
      throw new AramoError('VALIDATION_ERROR', 'Contact not found in tenant', 422, {
        requestId: args.requestId,
        details: { field: args.field, reason: 'contact_not_found', contact_id: args.id },
      });
    }
    if (args.company_id !== undefined && row.company_id !== args.company_id) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Contact belongs to a different company',
        422,
        {
          requestId: args.requestId,
          details: {
            field: args.field,
            reason: 'contact_company_mismatch',
            contact_id: args.id,
          },
        },
      );
    }
    if (row.deleted_at !== null) {
      throw new AramoError('CONTACT_DELETED', 'Contact has been deleted', 422, {
        requestId: args.requestId,
        details: { field: args.field, contact_id: args.id },
      });
    }
  }

  // CONTACTS-1 H-2 — recency rollup written by the contact-history path:
  // last_activity_at only moves forward. No-op for a deleted contact.
  async touchLastActivity(args: {
    tenant_id: string;
    id: string;
    at: Date;
  }): Promise<void> {
    await this.prisma.contact.updateMany({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        deleted_at: null,
        OR: [{ last_activity_at: null }, { last_activity_at: { lt: args.at } }],
      },
      data: { last_activity_at: args.at },
    });
  }

  // CONTACTS-1 SD-5 — display names for screens that still reference a contact
  // (including a deleted one, flagged so the UI can render "Name (Deleted)").
  async findDisplayByIds(args: {
    tenant_id: string;
    ids: readonly string[];
  }): Promise<Map<string, { name: string; deleted: boolean; company_id: string }>> {
    if (args.ids.length === 0) return new Map();
    const rows = (await this.prisma.contact.findMany({
      where: { tenant_id: args.tenant_id, id: { in: Array.from(args.ids) } },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        company_id: true,
        deleted_at: true,
      },
    })) as Array<{
      id: string;
      first_name: string;
      last_name: string;
      company_id: string;
      deleted_at: Date | null;
    }>;
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: `${r.first_name} ${r.last_name}`.trim(),
          deleted: r.deleted_at !== null,
          company_id: r.company_id,
        },
      ]),
    );
  }
}
