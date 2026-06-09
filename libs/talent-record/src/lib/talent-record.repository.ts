import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import type { UpdateTalentRecordRequestDto } from './dto/update-talent-record-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// TalentRecordRepository — write + read surface for TalentRecord.
// Reference CRUD (no metering, no event log, no state machine).
//
// Tenant + site scoped. NO visibility filter — TalentRecord is visible
// to all entitled + scoped recruiters in the tenant (unlike requisition,
// which gates by RequisitionAssignment). The recruiter view is uniform.
//
// R10: this repo never reads or writes a portal-forbidden numeric /
// ordinal field — the row shape (TalentRecordRow) does not carry one.

interface TalentRecordRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  first_name: string;
  last_name: string;
  email1: string | null;
  email2: string | null;
  phone_home: string | null;
  phone_cell: string | null;
  phone_work: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  source: string | null;
  key_skills: string | null;
  current_employer: string | null;
  current_pay: string | null;
  desired_pay: string | null;
  date_available: Date | null;
  can_relocate: boolean;
  is_hot: boolean;
  notes: string | null;
  web_site: string | null;
  best_time_to_call: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  // PR-A5b-2 — the Core-Talent link (nullable; null for unlinked).
  core_talent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: TalentRecordRow): TalentRecordView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email1: row.email1,
    email2: row.email2,
    phone_home: row.phone_home,
    phone_cell: row.phone_cell,
    phone_work: row.phone_work,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    source: row.source,
    key_skills: row.key_skills,
    current_employer: row.current_employer,
    current_pay: row.current_pay,
    desired_pay: row.desired_pay,
    date_available:
      row.date_available === null ? null : row.date_available.toISOString(),
    can_relocate: row.can_relocate,
    is_hot: row.is_hot,
    notes: row.notes,
    web_site: row.web_site,
    best_time_to_call: row.best_time_to_call,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    core_talent_id: row.core_talent_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Search PR-2 — raw-SQL row from searchByResumeText. tr.* yields the snake-
// case TalentRecord columns; the pg adapter may hand back timestamptz as Date
// OR string, so the projection coerces defensively.
interface RawSearchRow extends Omit<TalentRecordRow, 'date_available' | 'created_at' | 'updated_at'> {
  date_available: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  resume_snippet: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectSearchRow(row: RawSearchRow): TalentRecordView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email1: row.email1,
    email2: row.email2,
    phone_home: row.phone_home,
    phone_cell: row.phone_cell,
    phone_work: row.phone_work,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    source: row.source,
    key_skills: row.key_skills,
    current_employer: row.current_employer,
    current_pay: row.current_pay,
    desired_pay: row.desired_pay,
    date_available: row.date_available === null ? null : toIso(row.date_available),
    can_relocate: row.can_relocate,
    is_hot: row.is_hot,
    notes: row.notes,
    web_site: row.web_site,
    best_time_to_call: row.best_time_to_call,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    core_talent_id: row.core_talent_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    resume_snippet: row.resume_snippet,
  };
}

@Injectable()
export class TalentRecordRepository {
  private readonly logger = new Logger(TalentRecordRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateTalentRecordRequestDto;
  }): Promise<TalentRecordView> {
    const { tenant_id, entered_by_id, input } = args;
    const row = await this.prisma.talentRecord.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        first_name: input.first_name,
        last_name: input.last_name,
        email1: input.email1 ?? null,
        email2: input.email2 ?? null,
        phone_home: input.phone_home ?? null,
        phone_cell: input.phone_cell ?? null,
        phone_work: input.phone_work ?? null,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        source: input.source ?? null,
        key_skills: input.key_skills ?? null,
        current_employer: input.current_employer ?? null,
        current_pay: input.current_pay ?? null,
        desired_pay: input.desired_pay ?? null,
        date_available:
          input.date_available === undefined
            ? null
            : new Date(input.date_available),
        can_relocate: input.can_relocate ?? false,
        is_hot: input.is_hot ?? false,
        notes: input.notes ?? null,
        web_site: input.web_site ?? null,
        best_time_to_call: input.best_time_to_call ?? null,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
      },
    });
    return projectView(row as TalentRecordRow);
  }

  // PR-A8-1 — import-engine create. Mirrors create(); attributes the
  // row to the import batch for reversion. Sets `core_talent_id = NULL`
  // unconditionally — THE non-negotiable boundary (directive §0): the
  // engine creates `TalentRecord` rows but NEVER calls Core Talent's
  // createTalent / createOverlay. Canonicalization is M6/T2. The
  // load-bearing integration-spec assertion is `talent.*` bit-identical
  // row-count pre/post (the A5b-2 boundary proof, replayed at the
  // import layer).
  async createForImport(args: {
    tenant_id: string;
    entered_by_id: string;
    import_batch_id: string;
    input: CreateTalentRecordRequestDto;
  }): Promise<TalentRecordView> {
    const { tenant_id, entered_by_id, import_batch_id, input } = args;
    const row = await this.prisma.talentRecord.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        first_name: input.first_name,
        last_name: input.last_name,
        email1: input.email1 ?? null,
        email2: input.email2 ?? null,
        phone_home: input.phone_home ?? null,
        phone_cell: input.phone_cell ?? null,
        phone_work: input.phone_work ?? null,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        source: input.source ?? null,
        key_skills: input.key_skills ?? null,
        current_employer: input.current_employer ?? null,
        current_pay: input.current_pay ?? null,
        desired_pay: input.desired_pay ?? null,
        date_available:
          input.date_available === undefined
            ? null
            : new Date(input.date_available),
        can_relocate: input.can_relocate ?? false,
        is_hot: input.is_hot ?? false,
        notes: input.notes ?? null,
        web_site: input.web_site ?? null,
        best_time_to_call: input.best_time_to_call ?? null,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
        // core_talent_id is OMITTED — defaults to NULL. THE boundary.
        import_batch_id,
      },
    });
    return projectView(row as TalentRecordRow);
  }

  // PR-A8-1 — import-engine reversion. Tenant-scoped deleteMany by the
  // back-reference. Returns the delete count for the audit log.
  async deleteByImportBatch(args: {
    tenant_id: string;
    import_batch_id: string;
  }): Promise<number> {
    const result = await this.prisma.talentRecord.deleteMany({
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
  }): Promise<TalentRecordView | null> {
    const row = await this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as TalentRecordRow);
  }

  async list(args: {
    tenant_id: string;
    site_id?: string;
    // Search PR-1 — optional ILIKE-contains quick-search term (trimmed,
    // non-empty when present; the controller gates ?q= on talent:search).
    // Trigram-accelerated via the pg_trgm GIN indexes on first_name /
    // last_name. The OR is a sibling key ANDed with tenant+site (talent is
    // pool-open — no visibility OR to collide with).
    q?: string;
    limit?: number;
  }): Promise<TalentRecordView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.talentRecord.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(args.q === undefined
          ? {}
          : {
              OR: [
                { first_name: { contains: args.q, mode: 'insensitive' } },
                { last_name: { contains: args.q, mode: 'insensitive' } },
              ],
            }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as TalentRecordRow[]).map(projectView);
  }

  // Search PR-2 — résumé full-text content-search (GET /v1/talent-records
  // ?resume_q=). DISTINCT from PR-1's ?q= name-search (which is untouched).
  //
  // Lead rulings: R3 — websearch_to_tsquery('english', :q) matched against the
  // GENERATED tsvector (GIN-indexed), ts_rank-ordered; ts_headline yields the
  // D2 snippet over the REDACTED text (no SSN). R4 — when ?q= is ALSO present,
  // the name-ILIKE is ANDed (both filters narrow).
  //
  // VISIBILITY-AND: talent is pool-open (no per-record resolver), so the
  // "visibility" is tenant + optional site. Both are bound in the WHERE — a
  // résumé match in another tenant (or another site, when site-scoped) is
  // structurally absent. The match NARROWS within tenant+site; it never widens.
  //
  // Hand-authored raw SQL (Prisma cannot express @@ / ts_rank / ts_headline).
  // Parameterized positionally ($1..$n) — no interpolation of user input.
  async searchByResumeText(args: {
    tenant_id: string;
    site_id?: string;
    resume_q: string;
    // Optional name filter — present only when ?q= AND ?resume_q= both given
    // (Ruling R4 AND). ILIKE-contains over first_name/last_name (PR-1 parity).
    q?: string;
    limit?: number;
  }): Promise<TalentRecordView[]> {
    const limit = Math.min(args.limit ?? 50, 200);

    // $1 = the résumé query text (used in ts_headline, the @@ match, ts_rank).
    // $2 = tenant_id.
    const params: unknown[] = [args.resume_q, args.tenant_id];
    const conds: string[] = [
      'tr.tenant_id = $2',
      "rt.search_tsv @@ websearch_to_tsquery('english', $1)",
    ];
    if (args.site_id !== undefined) {
      params.push(args.site_id);
      conds.push(`tr.site_id = $${params.length}`);
    }
    if (args.q !== undefined) {
      params.push(`%${args.q}%`);
      const p = params.length;
      conds.push(`(tr.first_name ILIKE $${p} OR tr.last_name ILIKE $${p})`);
    }
    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const sql = `
      SELECT tr.*,
             ts_headline('english', rt.redacted_text,
               websearch_to_tsquery('english', $1),
               'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=5,MaxWords=18'
             ) AS resume_snippet
      FROM "talent_record"."TalentRecord" tr
      JOIN "talent_record"."talent_resume_text" rt
        ON rt.talent_record_id = tr.id
      WHERE ${conds.join(' AND ')}
      ORDER BY ts_rank(rt.search_tsv, websearch_to_tsquery('english', $1)) DESC
      LIMIT ${limitPlaceholder}
    `;

    const rows = await this.prisma.$queryRawUnsafe<RawSearchRow[]>(
      sql,
      ...params,
    );
    return rows.map(projectSearchRow);
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: {
    tenant_id: string;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.talentRecord.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateTalentRecordRequestDto;
    requestId: string;
  }): Promise<TalentRecordView> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const i = args.input;
    const data: Record<string, unknown> = {};
    if (i.first_name !== undefined) data['first_name'] = i.first_name;
    if (i.last_name !== undefined) data['last_name'] = i.last_name;
    if (i.email1 !== undefined) data['email1'] = i.email1;
    if (i.email2 !== undefined) data['email2'] = i.email2;
    if (i.phone_home !== undefined) data['phone_home'] = i.phone_home;
    if (i.phone_cell !== undefined) data['phone_cell'] = i.phone_cell;
    if (i.phone_work !== undefined) data['phone_work'] = i.phone_work;
    if (i.address !== undefined) data['address'] = i.address;
    if (i.address2 !== undefined) data['address2'] = i.address2;
    if (i.city !== undefined) data['city'] = i.city;
    if (i.state !== undefined) data['state'] = i.state;
    if (i.zip !== undefined) data['zip'] = i.zip;
    if (i.source !== undefined) data['source'] = i.source;
    if (i.key_skills !== undefined) data['key_skills'] = i.key_skills;
    if (i.current_employer !== undefined) data['current_employer'] = i.current_employer;
    if (i.current_pay !== undefined) data['current_pay'] = i.current_pay;
    if (i.desired_pay !== undefined) data['desired_pay'] = i.desired_pay;
    if (i.date_available !== undefined) data['date_available'] = i.date_available === null ? null : new Date(i.date_available);
    if (i.can_relocate !== undefined) data['can_relocate'] = i.can_relocate;
    if (i.is_hot !== undefined) data['is_hot'] = i.is_hot;
    if (i.notes !== undefined) data['notes'] = i.notes;
    if (i.web_site !== undefined) data['web_site'] = i.web_site;
    if (i.best_time_to_call !== undefined) data['best_time_to_call'] = i.best_time_to_call;
    if (i.owner_id !== undefined) data['owner_id'] = i.owner_id;

    const row = await this.prisma.talentRecord.update({
      where: { id: args.id },
      data,
    });
    return projectView(row as TalentRecordRow);
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
        'TalentRecord not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.talentRecord.delete({ where: { id: args.id } });
  }

  // -------------------------------------------------------------------------
  // PR-A5b-2 — Core-Talent link write surface (data-only).
  //
  // setLink / clearLink are PRIMITIVE column writes — no cross-lib
  // validation lives here. The two-step in-tenant gate
  // (Talent exists in Core + tenant has an overlay) is run by
  // TalentLinkService BEFORE calling these methods. Both calls are
  // tenant-scoped at the row level (WHERE id = :id AND tenant_id = :t)
  // so a controller mistake cannot set the link on a row from a
  // different tenant.
  // -------------------------------------------------------------------------

  async setLink(args: {
    tenant_id: string;
    id: string;
    core_talent_id: string;
  }): Promise<TalentRecordView | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: { core_talent_id: args.core_talent_id },
    });
    if (result.count === 0) {
      // Row was not in tenant (or vanished) — caller handles as
      // NOT_FOUND. We don't throw here so the read-after-write below
      // is the single fetch point.
      return null;
    }
    return this.findById({ tenant_id: args.tenant_id, id: args.id });
  }

  async clearLink(args: {
    tenant_id: string;
    id: string;
  }): Promise<TalentRecordView | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: { core_talent_id: null },
    });
    if (result.count === 0) {
      return null;
    }
    return this.findById({ tenant_id: args.tenant_id, id: args.id });
  }
}
