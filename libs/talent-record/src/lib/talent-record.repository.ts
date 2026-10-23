import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import {
  isAvailabilityStatus,
  isEngagementType,
  isWorkAuthorization,
  type AvailabilityStatus,
  type EngagementType,
  type WorkAuthorization,
} from './dto/stated-fields.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import type {
  NativeFacetBucket,
  NativeFacets,
  TalentSearchPage,
  TalentSearchQuery,
  TalentSortKey,
  SortDir,
} from './dto/talent-search.dto.js';
import type { UpdateTalentRecordRequestDto } from './dto/update-talent-record-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';
import { normalizePhoneForDedupe } from './talent-phone.js';
import {
  TALENT_EVENT_CREATED,
  TALENT_EVENT_DELETED,
  TALENT_EVENT_PROFILE_UPDATED,
  writeTalentEvent,
  type TalentEventInput,
  type TalentEventOutboxWriter,
} from './talent-events/talent-event-outbox.js';

// D4 — the post-commit talent.profile_updated append: first try + 3 retries.
const PROFILE_UPDATED_APPEND_ATTEMPTS = 4;

// Closed-vocabulary guard (stated-fields amendment §4/§5). The talent-record
// DTOs are interfaces (no class-validator), so the @IsIn intent is enforced
// here at the write boundary: a provided-but-out-of-vocabulary value is a 400.
// undefined (not supplied) and null (cleared) both pass.
function assertStatedFields(
  input: {
    availability_status?: string | null;
    engagement_type?: string | null;
    work_authorization?: string | null;
  },
  requestId: string,
): void {
  if (
    input.availability_status != null &&
    !isAvailabilityStatus(input.availability_status)
  ) {
    throw new AramoError('VALIDATION_ERROR', 'Invalid availability_status', 400, {
      requestId,
      details: { field: 'availability_status' },
    });
  }
  if (input.engagement_type != null && !isEngagementType(input.engagement_type)) {
    throw new AramoError('VALIDATION_ERROR', 'Invalid engagement_type', 400, {
      requestId,
      details: { field: 'engagement_type' },
    });
  }
  if (
    input.work_authorization != null &&
    !isWorkAuthorization(input.work_authorization)
  ) {
    throw new AramoError('VALIDATION_ERROR', 'Invalid work_authorization', 400, {
      requestId,
      details: { field: 'work_authorization' },
    });
  }
}

// ATI-SEP-1 A2 — a provided date_available must be a real instant. Validated up
// front (400) rather than surfacing as a write-time failure: before A2 an
// unparseable value threw inside the create AFTER the intake draft had been
// claimed PROMOTED, stranding it. undefined / null pass.
function assertDateAvailable(
  input: { date_available?: string | null },
  requestId: string,
): void {
  const v = input.date_available;
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || v.trim() === '' || Number.isNaN(new Date(v).getTime())) {
    throw new AramoError('VALIDATION_ERROR', 'Invalid date_available', 400, {
      requestId,
      details: { field: 'date_available' },
    });
  }
}

// TalentRecord Admission Invariant (structural enforcement). A TalentRecord
// represents a genuine, ATS-operable profile and MUST NOT be created unless the
// minimum identity + contact anchors are present: first_name, last_name, a
// primary email, and a primary (cell) phone. This guard is the NON-BYPASSABLE
// boundary — it runs inside every creation method (create = manual + governed
// promotion; createForImport = import engine), so no caller can admit an
// incomplete record. Incomplete/discovered/imported/webhook-arrived person data
// MUST remain in the pre-Talent staging/identity/evidence substrate and cross
// this boundary only through a governed admission/promotion decision (the
// promotion gate defers; the import engine skips) — never as a half-formed row.
function assertAdmissible(
  input: { first_name?: string; last_name?: string; email1?: string; phone_cell?: string },
  requestId: string,
): void {
  const missing: string[] = [];
  if ((input.first_name ?? '').trim() === '') missing.push('first_name');
  if ((input.last_name ?? '').trim() === '') missing.push('last_name');
  if ((input.email1 ?? '').trim() === '') missing.push('email1');
  if ((input.phone_cell ?? '').trim() === '') missing.push('phone_cell');
  if (missing.length > 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'A TalentRecord requires a name, a primary email, and a cell phone (admission invariant).',
      422,
      { requestId, details: { missing } },
    );
  }
}

// ATI-SEP-1 A2 — the create-time VALIDATION gate, exported so every create
// composition (manual create, intake Save) can run it FIRST, before any state
// change: the admission invariant (422) + closed-vocabulary stated fields (400)
// + date_available (400). repo.create re-runs it as the non-bypassable backstop.
export function validateTalentCreateInput(
  input: CreateTalentRecordRequestDto,
  requestId: string,
): void {
  assertAdmissible(input, requestId);
  assertStatedFields(input, requestId);
  assertDateAvailable(input, requestId);
}

// ATI-SEP-1 A2 — the tenant-local duplicate a create would collide with.
export interface ActiveTalentDuplicate {
  id: string;
  reason: 'email' | 'phone';
}

// The 409 a duplicate create returns (same code/message family on every path).
export function talentDuplicateError(
  dup: ActiveTalentDuplicate,
  requestId: string,
): AramoError {
  return dup.reason === 'email'
    ? new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this primary email already exists in your tenant.',
        409,
        { requestId, details: { reason: 'email', existing_id: dup.id } },
      )
    : new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this cell phone already exists in your tenant.',
        409,
        { requestId, details: { reason: 'phone', existing_id: dup.id } },
      );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

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
  country: string; // B2 — NOT NULL DEFAULT 'US'
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
  title: string | null; // B1
  availability_status: AvailabilityStatus | null;
  engagement_type: EngagementType | null;
  work_authorization: WorkAuthorization | null;
  owner_id: string | null;
  entered_by_id: string | null;
  // 4e-rest — the PERSON_CLUSTER pointer (identity_index). SERVER-ONLY: it is
  // carried on the internal row for TalentLinkService's link-state reads via
  // findLinkState, and is DELIBERATELY absent from projectView / TalentRecordView
  // (cluster_id is a cross-tenant id — never rendered to a tenant-visible surface).
  cluster_id: string | null;
  // TR-2a-B3a (DDR-3 §3) — the record supersession lifecycle axis (distinct from
  // tenant_status). record_status defaults 'live'; the superseded_* pair is set
  // by the reconcile writer (B3b, writer-less here). Carried on the internal row;
  // surfaced to the view ONLY on the detail read (projectViewWithSupersession).
  record_status: string;
  superseded_by_record_id: string | null;
  superseded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// The minimal talent contact/stated fields the requisition-expander enrichment
// projects onto PipelineView via the apps/api composition. RAW values — the
// talent:read gate + consent (do_not_contact) suppression are applied downstream
// in apps/api, never here (Segment-4 consent-free constraint).
export interface TalentContactFields {
  readonly email: string | null;
  readonly phone: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly work_authorization: string | null;
  readonly desired_pay: string | null;
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
    country: row.country,
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
    title: row.title,
    availability_status: row.availability_status,
    engagement_type: row.engagement_type,
    work_authorization: row.work_authorization,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// TR-2a-B3a (DDR-3 §3) — the DETAIL projection: projectView + the supersession
// metadata. findById is the ONLY read that returns superseded rows, so it is the
// only surface that carries the metadata (list/search are live-only, so they use
// the byte-identical projectView). On a stale link the consumer reads
// record_status='superseded' + superseded_by_record_id → where the survivor is.
function projectDetailView(row: TalentRecordRow): TalentRecordView {
  return {
    ...projectView(row),
    record_status: row.record_status === 'superseded' ? 'superseded' : 'live',
    superseded_by_record_id: row.superseded_by_record_id,
    superseded_at:
      row.superseded_at === null ? null : row.superseded_at.toISOString(),
    recruiting_ready: computeRecruitingReady(row),
  };
}

// B5 — recruiting-readiness predicate. A DERIVED boolean (never a number, R10)
// over the record's OWN state: a live record with at least one contact channel
// and a stated work authorization is ready to recruit. Detail-read only.
function computeRecruitingReady(row: TalentRecordRow): boolean {
  const live = row.record_status !== 'superseded';
  const hasContact =
    (row.email1 ?? '') !== '' || (row.phone_cell ?? '') !== '';
  const hasWorkAuthorization = row.work_authorization !== null;
  return live && hasContact && hasWorkAuthorization;
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
    country: row.country,
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
    title: row.title,
    availability_status: row.availability_status,
    engagement_type: row.engagement_type,
    work_authorization: row.work_authorization,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    resume_snippet: row.resume_snippet,
  };
}

// ── Segment 4 — server-side search helpers (single-schema) ──

// Opaque keyset cursor = the last row id (base64url). Keyset correctness comes
// from the deterministic orderBy (sort col(s) + id tiebreak) + Prisma's
// cursor:{id}/skip:1.
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

// Each sort ends with `id` so the keyset is total-ordered (no skips/dupes).
function buildOrderBy(
  sort: TalentSortKey,
  dir: SortDir,
): Array<Record<string, SortDir>> {
  switch (sort) {
    case 'name':
      return [{ last_name: dir }, { first_name: dir }, { id: dir }];
    case 'owner':
      return [{ owner_id: dir }, { id: dir }];
    case 'location':
      return [{ city: dir }, { state: dir }, { id: dir }];
    case 'availability':
      return [{ availability_status: dir }, { id: dir }];
    case 'engagement':
      return [{ engagement_type: dir }, { id: dir }];
    case 'hot':
      return [{ is_hot: dir }, { id: dir }];
    case 'created_at':
    default:
      return [{ created_at: dir }, { id: dir }];
  }
}

// Build the single-schema Prisma WHERE from the search query. Pure native
// columns; the `id_allowlist` is how presets / My-team narrow (resolve-then-
// filter — the ids are resolved cross-schema in apps/api and passed in here).
function buildSearchWhere(q: TalentSearchQuery): Record<string, unknown> {
  // TR-2a-B3a (DDR-3 §3) — search (searchPaged + findFilteredKeys, incl. the
  // faceted counts computed over this WHERE) defaults to live-only, matching
  // list(). A superseded record never surfaces in a tenant search or its facets.
  const where: Record<string, unknown> = {
    tenant_id: q.tenant_id,
    record_status: 'live',
  };
  const and: Array<Record<string, unknown>> = [];
  if (q.site_id !== undefined) where['site_id'] = q.site_id;
  if (q.is_hot !== undefined) where['is_hot'] = q.is_hot;
  if (q.engagement_type && q.engagement_type.length > 0) {
    where['engagement_type'] = { in: [...q.engagement_type] };
  }
  if (q.source && q.source.length > 0) {
    where['source'] = { in: [...q.source] };
  }
  if (q.owner_id && q.owner_id.length > 0) {
    where['owner_id'] = { in: [...q.owner_id] };
  }
  // CRM-4 — id allow/deny. Allowlist = INCLUDE (presets / working-with-me / FE
  // ids); denylist = EXCLUDE (Not-contacted-90+). Both compose on `id` (AND).
  if (q.id_allowlist != null || q.id_denylist != null) {
    where['id'] = {
      ...(q.id_allowlist != null ? { in: [...q.id_allowlist] } : {}),
      ...(q.id_denylist != null ? { notIn: [...q.id_denylist] } : {}),
    };
  }
  // availability "unknown" bucket matches BOTH null and the explicit 'unknown'.
  if (q.availability_status && q.availability_status.length > 0) {
    const vals = [...q.availability_status];
    if (vals.includes('unknown')) {
      and.push({
        OR: [{ availability_status: { in: vals } }, { availability_status: null }],
      });
    } else {
      where['availability_status'] = { in: vals };
    }
  }
  if (q.q !== undefined && q.q.trim() !== '') {
    // CRM-2 — the Talent page's single free-text box matches "name, title,
    // skill, or location" in one OR (no visible key:value grammar). This is the
    // PAGED/faceted path only; the name-only list() path (enterprise-search
    // lexical leg) is unchanged. Structured skill/location FILTERS stay separate
    // (ANDed) via q.skills / q.location below.
    const term = q.q;
    and.push({
      OR: [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { key_skills: { contains: term, mode: 'insensitive' } },
        { city: { contains: term, mode: 'insensitive' } },
        { state: { contains: term, mode: 'insensitive' } },
      ],
    });
  }
  if (q.location !== undefined && q.location.trim() !== '') {
    and.push({
      OR: [
        { city: { contains: q.location, mode: 'insensitive' } },
        { state: { contains: q.location, mode: 'insensitive' } },
      ],
    });
  }
  const skills = (q.skills ?? []).filter((s) => s.trim() !== '');
  if (skills.length > 0) {
    const clauses = skills.map((s) => ({
      key_skills: { contains: s, mode: 'insensitive' },
    }));
    and.push(q.skill_match === 'all' ? { AND: clauses } : { OR: clauses });
  }
  if (and.length > 0) where['AND'] = and;
  return where;
}

interface GroupRow {
  readonly _count: { readonly _all: number };
  readonly [k: string]: unknown;
}
function toBuckets(
  rows: readonly GroupRow[],
  key: string,
  opts: { nullAs?: string; dropNullOrEmpty?: boolean } = {},
): NativeFacetBucket[] {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    let value: string;
    if (
      raw === null ||
      raw === undefined ||
      (typeof raw === 'string' && raw.trim() === '')
    ) {
      if (opts.dropNullOrEmpty === true) continue;
      value = opts.nullAs ?? 'unknown';
    } else {
      value = String(raw);
    }
    tally.set(value, (tally.get(value) ?? 0) + r._count._all);
  }
  return [...tally.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

@Injectable()
export class TalentRecordRepository {
  private readonly logger = new Logger(TalentRecordRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateTalentRecordRequestDto;
    requestId?: string;
    // Promotion-Trigger slice-A — the per-tenant lifecycle status at mint. A
    // SERVER-side param (NOT on the wire DTO): the recruiter create omits it
    // (→ null); the promotion path sets 'sourced'. Nullable string, no enum;
    // nothing else writes tenant_status (the former tenant-overlay writer is
    // retired).
    tenant_status?: string;
    // TALENT-INTEL-1 TI-1F-C (strengthened-D) — a RESERVED talent_id: for the
    // draft-backed create the id is reserved up-front (draft.talent_id) so the
    // accepted resume evidence lifecycle is established FIRST and TalentRecord is
    // the final admission step. Omitted on the normal path → Prisma default uuid.
    // ATI-SEP-1 A2 — with a reserved id the create is IDEMPOTENT: a replay that
    // finds the row already committed returns it and writes nothing (no second
    // talent.created).
    id?: string;
    // ATI-SEP-1 A2 — re-check the tenant-local email1 / phone_cell duplicate
    // INSIDE the create transaction under per-value advisory locks, so two
    // concurrent creates of the same human cannot both commit (a different live
    // record → 409). The caller still pre-checks for a cheap early 409.
    dedupe?: boolean;
    // ATI-SEP-1 A3 — context carried on the talent.created outbox row.
    event?: { intake_draft_id?: string; correlation_id?: string | null };
    // ATI-SEP-1 A2 — the first résumé edition's pending text row, written in the
    // SAME transaction (the reindex work signal; never lost to a soft-fail).
    resume_reindex?: { storage_key: string; resume_edition_id: string };
  }): Promise<TalentRecordView> {
    const { tenant_id, input } = args;
    const requestId = args.requestId ?? '';
    validateTalentCreateInput(input, requestId);
    let row: unknown;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        if (args.dedupe === true) {
          await this.lockDuplicateKeys(tx, tenant_id, input.email1, input.phone_cell);
          const dup = await this.findActiveDuplicateIn(tx, {
            tenant_id,
            email1: input.email1,
            phone_cell: input.phone_cell,
            ...(args.id !== undefined ? { exclude_id: args.id } : {}),
          });
          if (dup !== null) throw talentDuplicateError(dup, requestId);
        }
        const created = await tx.talentRecord.create({
          data: this.createData(args),
        });
        if (args.resume_reindex !== undefined) {
          await tx.talentResumeText.create({
            data: {
              tenant_id,
              talent_record_id: created.id,
              storage_key: args.resume_reindex.storage_key,
              resume_edition_id: args.resume_reindex.resume_edition_id,
              status: 'pending',
            },
          });
        }
        await writeTalentEvent(tx as unknown as TalentEventOutboxWriter, {
          tenant_id,
          event_type: TALENT_EVENT_CREATED,
          talent_record_id: created.id,
          ...(args.event?.intake_draft_id !== undefined
            ? { intake_draft_id: args.event.intake_draft_id }
            : {}),
          correlation_id: args.event?.correlation_id ?? (requestId !== '' ? requestId : null),
        });
        return created;
      });
    } catch (err) {
      // Reserved-id replay: the row committed on an earlier/concurrent attempt.
      if (args.id !== undefined && isUniqueViolation(err)) {
        const existing = await this.findById({ tenant_id, id: args.id });
        if (existing !== null) return existing;
      }
      throw err;
    }
    return projectView(row as TalentRecordRow);
  }

  // The TalentRecord create payload (shared by the transactional create).
  private createData(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateTalentRecordRequestDto;
    tenant_status?: string;
    id?: string;
  }) {
    const { tenant_id, entered_by_id, input } = args;
    return {
      ...(args.id !== undefined ? { id: args.id } : {}),
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
      country: input.country ?? 'US',
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
      title: input.title ?? null,
      availability_status: input.availability_status ?? null,
      engagement_type: input.engagement_type ?? null,
      work_authorization: input.work_authorization ?? null,
      owner_id: input.owner_id ?? entered_by_id,
      entered_by_id,
      tenant_status: args.tenant_status ?? null,
      phone_cell_normalized: normalizePhoneForDedupe(input.phone_cell),
    };
  }

  // ATI-SEP-1 A2 — serialize creates of the same email1 / phone_cell value within
  // a tenant for the life of the transaction (released at COMMIT/ROLLBACK).
  private async lockDuplicateKeys(
    tx: { $executeRaw: PrismaService['$executeRaw'] },
    tenant_id: string,
    email1: string | null | undefined,
    phone_cell: string | null | undefined,
  ): Promise<void> {
    const keys: string[] = [];
    const email = (email1 ?? '').trim().toLowerCase();
    if (email !== '') keys.push(`talent-dedupe:${tenant_id}:email:${email}`);
    const phone = normalizePhoneForDedupe(phone_cell);
    if (phone !== null) keys.push(`talent-dedupe:${tenant_id}:phone:${phone}`);
    for (const key of keys.sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private async findActiveDuplicateIn(
    client: Pick<PrismaService, 'talentRecord'>,
    args: {
      tenant_id: string;
      email1?: string | null;
      phone_cell?: string | null;
      exclude_id?: string;
    },
  ): Promise<ActiveTalentDuplicate | null> {
    const exclude = args.exclude_id !== undefined ? { id: { not: args.exclude_id } } : {};
    const email = (args.email1 ?? '').trim();
    if (email !== '') {
      const byEmail = await client.talentRecord.findFirst({
        where: {
          tenant_id: args.tenant_id,
          record_status: 'live',
          email1: { equals: email, mode: 'insensitive' },
          ...exclude,
        },
        select: { id: true },
      });
      if (byEmail !== null) return { id: byEmail.id, reason: 'email' };
    }
    const phone = normalizePhoneForDedupe(args.phone_cell);
    if (phone !== null) {
      const byPhone = await client.talentRecord.findFirst({
        where: {
          tenant_id: args.tenant_id,
          record_status: 'live',
          phone_cell_normalized: phone,
          ...exclude,
        },
        select: { id: true },
      });
      if (byPhone !== null) return { id: byPhone.id, reason: 'phone' };
    }
    return null;
  }

  // ATI-SEP-1 A2 — the create-time duplicate pre-check: a DIFFERENT live record
  // in the tenant with this primary email (case-insensitive) or this normalized
  // cell phone. exclude_id = the caller's own reserved id (a resumed Save is not
  // its own duplicate).
  async findActiveDuplicate(args: {
    tenant_id: string;
    email1?: string | null;
    phone_cell?: string | null;
    exclude_id?: string;
  }): Promise<ActiveTalentDuplicate | null> {
    return this.findActiveDuplicateIn(this.prisma, args);
  }

  // ATI-SEP-1 A2 — phone-keyed counterpart of findActiveByEmail.
  async findActiveByPhone(args: {
    tenant_id: string;
    phone: string;
  }): Promise<{ id: string } | null> {
    const phone = normalizePhoneForDedupe(args.phone);
    if (phone === null) return null;
    return this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, record_status: 'live', phone_cell_normalized: phone },
      select: { id: true },
    });
  }

  // ATI-SEP-1 A3 — a talent.profile_updated for an ATS evidence edit committed
  // outside a talent_record transaction (talent_evidence writes): appended right
  // after that commit. TalentRecord scalar edits emit inside update() instead.
  //
  // D4 — the evidence commit and this append cannot share a transaction (two
  // schemas, two clients), so the append is retried inline (1 + 3 attempts) and
  // a final failure is logged at error with the talent id, never thrown: the
  // edit is committed and a 5xx would only invite a duplicate re-submit.
  // RESIDUAL RISK: a crash or a persistent outbox failure between the evidence
  // commit and a successful append loses that one event; downstream consumers
  // then see the edit only on the Talent's next event (or a watermark backstop).
  async recordProfileUpdated(args: {
    tenant_id: string;
    talent_record_id: string;
    changed_fields: readonly string[];
    correlation_id?: string | null;
  }): Promise<void> {
    const event: TalentEventInput = {
      tenant_id: args.tenant_id,
      event_type: TALENT_EVENT_PROFILE_UPDATED,
      talent_record_id: args.talent_record_id,
      changed_fields: args.changed_fields,
      correlation_id: args.correlation_id ?? null,
    };
    for (let attempt = 1; attempt <= PROFILE_UPDATED_APPEND_ATTEMPTS; attempt += 1) {
      try {
        await writeTalentEvent(this.prisma as unknown as TalentEventOutboxWriter, event);
        return;
      } catch (err) {
        if (attempt === PROFILE_UPDATED_APPEND_ATTEMPTS) {
          // ids + field names only — never values.
          this.logger.error({
            event: 'talent_profile_updated_append_failed',
            tenant_id: args.tenant_id,
            talent_id: args.talent_record_id,
            changed_fields: [...args.changed_fields],
            attempts: attempt,
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }
  }

  // B3/B4 — manual-create dedup lookup. Returns the id of an ACTIVE (live)
  // TalentRecord in the tenant whose primary email matches (case-insensitive),
  // or null. Email is the primary identity anchor; the controller refuses a
  // manual create that would duplicate it. (ATI-SEP-1 A2 — the cell-phone
  // counterpart is findActiveByPhone over phone_cell_normalized.)
  async findActiveByEmail(args: {
    tenant_id: string;
    email: string;
  }): Promise<{ id: string } | null> {
    const email = args.email.trim();
    if (email === '') return null;
    return this.prisma.talentRecord.findFirst({
      where: {
        tenant_id: args.tenant_id,
        record_status: 'live',
        email1: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    });
  }

  // Enterprise Search (GS-1) — exact-identifier retrieval leg for the Talent adapter.
  // Matches email1 OR email2 exactly (case-insensitive) INSIDE the same pool-open
  // authority contract as list()/searchByResumeText: tenant + optional site + live-only.
  // This is NOT a bypass of that contract — an exact-email match in another tenant, or
  // (when site-scoped) another site, is structurally absent. Returns the lean views the
  // adapter maps to SearchHits.
  async searchByExactEmail(args: {
    tenant_id: string;
    site_id?: string;
    email: string;
    limit?: number;
  }): Promise<TalentRecordView[]> {
    const email = args.email.trim();
    if (email === '') return [];
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.talentRecord.findMany({
      where: {
        tenant_id: args.tenant_id,
        record_status: 'live',
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        OR: [
          { email1: { equals: email, mode: 'insensitive' } },
          { email2: { equals: email, mode: 'insensitive' } },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as TalentRecordRow[]).map(projectView);
  }

  // Proactive duplicate-check projection. Same tenant-wide, live-only,
  // case-insensitive email1 predicate as findActiveByEmail (the create-time
  // 409 backstop) — but returns the display fields the Add-Talent
  // "Possible existing Talent" card renders (name · title · city/state), so
  // the recruiter sees WHO the collision is with before ever pressing Create.
  // Tenant-wide (no site filter) to mirror the 409: an email that already
  // exists anywhere in the tenant is a duplicate regardless of site.
  async findDuplicateByEmail(args: {
    tenant_id: string;
    email: string;
  }): Promise<{
    id: string;
    first_name: string;
    last_name: string;
    title: string | null;
    city: string | null;
    state: string | null;
  } | null> {
    const email = args.email.trim();
    if (email === '') return null;
    return this.prisma.talentRecord.findFirst({
      where: {
        tenant_id: args.tenant_id,
        record_status: 'live',
        email1: { equals: email, mode: 'insensitive' },
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        title: true,
        city: true,
        state: true,
      },
    });
  }

  // ATI-SEP-1 A2 — phone-keyed counterpart of findDuplicateByEmail (the
  // proactive "Possible existing Talent" card): same live-only, tenant-wide
  // posture, matched on the normalized cell phone.
  async findDuplicateByPhone(args: {
    tenant_id: string;
    phone: string;
  }): Promise<{
    id: string;
    first_name: string;
    last_name: string;
    title: string | null;
    city: string | null;
    state: string | null;
  } | null> {
    const phone = normalizePhoneForDedupe(args.phone);
    if (phone === null) return null;
    return this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, record_status: 'live', phone_cell_normalized: phone },
      select: { id: true, first_name: true, last_name: true, title: true, city: true, state: true },
    });
  }

  // PR-A8-1 — import-engine create. Mirrors create(); attributes the
  // row to the import batch for reversion. THE non-negotiable boundary
  // (directive §0): the engine creates `TalentRecord` rows only and never
  // performs identity resolution — that is canonicalization's job (M6/T2).
  async createForImport(args: {
    tenant_id: string;
    entered_by_id: string;
    import_batch_id: string;
    input: CreateTalentRecordRequestDto;
  }): Promise<TalentRecordView> {
    const { tenant_id, entered_by_id, import_batch_id, input } = args;
    // Admission invariant backstop — the import engine pre-skips incomplete rows
    // (REQUIRED_FIELDS.talent_record), but the boundary is enforced here too so
    // no import path can admit a record missing a name/email/phone.
    assertAdmissible(input, import_batch_id);
    // ATI-SEP-1 A3 — the import create records talent.created in the same txn.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.talentRecord.create({
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
          country: input.country ?? 'US',
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
          title: input.title ?? null,
          owner_id: input.owner_id ?? entered_by_id,
          entered_by_id,
          // THE boundary: this create performs no identity resolution.
          import_batch_id,
          phone_cell_normalized: normalizePhoneForDedupe(input.phone_cell),
        },
      });
      await writeTalentEvent(tx as unknown as TalentEventOutboxWriter, {
        tenant_id,
        event_type: TALENT_EVENT_CREATED,
        talent_record_id: created.id,
        correlation_id: import_batch_id,
      });
      return created;
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

  // TR-2a-B3a (DDR-3 §3) — findById returns rows of ANY record_status (no
  // live-only filter): a superseded record is returned WITH its supersession
  // metadata so a stale link resolves informatively (projectDetailView). This is
  // deliberately the see-everything detail read; the live-only filter lives on
  // list/search (the tenant-facing enumerations) instead.
  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<TalentRecordView | null> {
    const row = await this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectDetailView(row as TalentRecordRow);
  }

  // Lane2-DDR §0/§6 — narrow, tenant-safe EXISTENCE read for the Pipeline's Add-Talent
  // precondition (selects only the id — never the PII record). Same posture as findById
  // (any record_status): an absent or cross-tenant id is false.
  async existsInTenant(args: { tenant_id: string; id: string }): Promise<boolean> {
    const row = await this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true },
    });
    return row !== null;
  }

  // COMM-B5 — narrow, tenant-safe read of ONLY the dialable phone slots for
  // outbound call initiation. Deliberately selects the three phone columns (not
  // the full PII record) so the caller resolves a destination without loading
  // the record. null = the record is absent or cross-tenant; a present record
  // with a null slot = no dialable number on file for that slot.
  async findDialablePhonesForTenant(args: {
    tenant_id: string;
    id: string;
  }): Promise<{ phone_cell: string | null; phone_work: string | null; phone_home: string | null } | null> {
    return this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { phone_cell: true, phone_work: true, phone_home: true },
    });
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
        // TR-2a-B3a (DDR-3 §3) — tenant-facing list defaults to live-only. A
        // superseded record is reachable only via findById (informative stale
        // link) and listByTenantKeyset (system backfill), never a tenant list.
        record_status: 'live',
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

  // Batch id → "First Last" resolution for cross-schema enrichment (e.g. the
  // My-Desk read surfaces the talent display name for pipeline/interview/
  // client-selection ids it already holds). One set-based, tenant-scoped query —
  // never per-row. Returns talent_id → display name; ids not resolvable
  // in-tenant are simply absent. No record_status filter: an id already held by
  // a live domain row should still resolve a name even if the record was later
  // superseded (mirrors findById's informative-stale posture, never a list).
  async findNamesByIds(args: {
    tenant_id: string;
    ids: readonly string[];
  }): Promise<Map<string, string>> {
    if (args.ids.length === 0) return new Map();
    const rows = await this.prisma.talentRecord.findMany({
      where: { tenant_id: args.tenant_id, id: { in: [...new Set(args.ids)] } },
      select: { id: true, first_name: true, last_name: true },
    });
    const out = new Map<string, string>();
    for (const r of rows as Array<{
      id: string;
      first_name: string;
      last_name: string;
    }>) {
      out.set(r.id, `${r.first_name} ${r.last_name}`.trim());
    }
    return out;
  }

  // CRM-7 (§11) — BATCH channel presence (has a phone / has an email) for a set
  // of talent ids. The My Desk follow-up CTA pairs this with the contacting-
  // consent summary to decide Call / Email / Open (the Talent-360 can_call /
  // can_email precedent). Absent id ⇒ both false.
  async findContactChannelsByIds(args: {
    tenant_id: string;
    ids: readonly string[];
  }): Promise<Map<string, { has_phone: boolean; has_email: boolean }>> {
    if (args.ids.length === 0) return new Map();
    const rows = await this.prisma.talentRecord.findMany({
      where: { tenant_id: args.tenant_id, id: { in: [...new Set(args.ids)] } },
      select: { id: true, phone_cell: true, email1: true },
    });
    const out = new Map<string, { has_phone: boolean; has_email: boolean }>();
    for (const r of rows as Array<{ id: string; phone_cell: string | null; email1: string | null }>) {
      out.set(r.id, {
        has_phone: (r.phone_cell ?? '') !== '',
        has_email: (r.email1 ?? '') !== '',
      });
    }
    return out;
  }

  // TR-2a-1 — stable keyset enumeration over ALL of a tenant's TalentRecords,
  // ordered (created_at, id) ascending, for the anchor-producer backfill (an
  // apps/api system op — no visibility scoping; it must see every record). The
  // caller pages forward by passing the last row's (created_at, id) as `after`.
  // TR-2a-B3a (DDR-3 §3) — DELIBERATELY see-everything: NO record_status filter.
  // The system backfill must observe superseded records too; the live-only
  // default is a tenant-facing (list/search) posture, not a system-read one.
  async listByTenantKeyset(args: {
    tenant_id: string;
    limit: number;
    after?: { created_at: string; id: string };
  }): Promise<TalentRecordView[]> {
    const limit = Math.min(args.limit, 500);
    const rows = await this.prisma.talentRecord.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.after === undefined
          ? {}
          : {
              OR: [
                { created_at: { gt: new Date(args.after.created_at) } },
                {
                  created_at: new Date(args.after.created_at),
                  id: { gt: args.after.id },
                },
              ],
            }),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return (rows as TalentRecordRow[]).map(projectView);
  }

  // ── Segment 4 — native server-side faceted search + keyset pagination ──
  // Single-schema: filter / sort / cursor / full-set facet COUNTS run against
  // TalentRecord columns ONLY. No cross-schema read here (apps/api composes the
  // last_activity / consent / stage work over the id set this returns).
  async searchPaged(query: TalentSearchQuery): Promise<TalentSearchPage> {
    const pageSize = Math.min(query.page_size ?? 50, 200);
    const dir: SortDir = query.dir ?? 'desc';
    const where = buildSearchWhere(query);
    const orderBy = buildOrderBy(query.sort ?? 'created_at', dir);

    const rows = await this.prisma.talentRecord.findMany({
      where,
      orderBy,
      take: pageSize + 1, // +1 to detect a next page
      ...(query.cursor != null && query.cursor !== ''
        ? { cursor: { id: decodeCursor(query.cursor) }, skip: 1 }
        : {}),
    });

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last !== undefined ? encodeCursor(last.id) : null;

    const facets = await this.computeNativeFacets(where);
    return {
      items: (pageRows as TalentRecordRow[]).map(projectView),
      next_cursor,
      facets,
    };
  }

  // Requisition-expander enrichment (LOCKED Aramo-Requisition-Expander-Talent-
  // Rate-Columns v1.0) — BATCH contact/stated-field read over an id set, for the
  // apps/api pipeline-list composition. Live-only (superseded rows never surface,
  // matching list/search). Returns RAW stated fields incl. contact PII; apps/api
  // applies talent:read + consent (do_not_contact suppression) — this lib stays
  // consent-free (Segment-4 constraint). Set-based, never N+1.
  async findContactByIds(
    tenant_id: string,
    ids: readonly string[],
  ): Promise<Map<string, TalentContactFields>> {
    const out = new Map<string, TalentContactFields>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.talentRecord.findMany({
      where: { tenant_id, record_status: 'live', id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        email1: true,
        phone_cell: true,
        city: true,
        state: true,
        work_authorization: true,
        desired_pay: true,
      },
    });
    for (const r of rows) {
      out.set(r.id, {
        email: r.email1 ?? null,
        phone: r.phone_cell ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        work_authorization: (r.work_authorization as string | null) ?? null,
        desired_pay: r.desired_pay ?? null,
      });
    }
    return out;
  }

  // Full filtered key set (no pagination) — apps/api's cross-schema path runs
  // the Seg-3 batch accessors over this, bounded by the materialize guard (it
  // asks for at most `limit`+1 rows to detect "over the guard"). Returns the
  // TalentRecord id (activity / pipeline / consent are all TalentRecord-keyed).
  async findFilteredKeys(
    query: TalentSearchQuery,
    limit: number,
  ): Promise<Array<{ id: string }>> {
    const rows = await this.prisma.talentRecord.findMany({
      where: buildSearchWhere(query),
      select: { id: true },
      take: limit + 1,
    });
    return rows;
  }

  private async computeNativeFacets(
    where: Record<string, unknown>,
  ): Promise<NativeFacets> {
    const [avail, eng, src, hot] = await Promise.all([
      this.prisma.talentRecord.groupBy({
        by: ['availability_status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.talentRecord.groupBy({
        by: ['engagement_type'],
        where,
        _count: { _all: true },
      }),
      this.prisma.talentRecord.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
      }),
      this.prisma.talentRecord.count({ where: { ...where, is_hot: true } }),
    ]);
    return {
      availability: toBuckets(avail as GroupRow[], 'availability_status', {
        nullAs: 'unknown',
      }),
      engagement: toBuckets(eng as GroupRow[], 'engagement_type', {
        dropNullOrEmpty: true,
      }),
      source: toBuckets(src as GroupRow[], 'source', { dropNullOrEmpty: true }),
      hot,
    };
  }

  // Search PR-2 — resume full-text content-search (GET /v1/talent-records
  // ?resume_q=). DISTINCT from PR-1's ?q= name-search (which is untouched).
  //
  // Lead rulings: R3 — websearch_to_tsquery('english', :q) matched against the
  // GENERATED tsvector (GIN-indexed), ts_rank-ordered; ts_headline yields the
  // D2 snippet over the REDACTED text (no SSN). R4 — when ?q= is ALSO present,
  // the name-ILIKE is ANDed (both filters narrow).
  //
  // VISIBILITY-AND: talent is pool-open (no per-record resolver), so the
  // "visibility" is tenant + optional site. Both are bound in the WHERE — a
  // resume match in another tenant (or another site, when site-scoped) is
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

    // $1 = the resume query text (used in ts_headline, the @@ match, ts_rank).
    // $2 = tenant_id.
    const params: unknown[] = [args.resume_q, args.tenant_id];
    const conds: string[] = [
      'tr.tenant_id = $2',
      // TR-2a-B3a (DDR-3 §3) — resume content-search is live-only, matching
      // list()/searchPaged. A superseded record never surfaces in a ?resume_q=.
      "tr.record_status = 'live'",
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

    // TI-1H §8 — resume text is now per-edition (many rows per talent). Preserve
    // the pre-TI-1H product behavior "a talent matches if any of its resume text
    // matches, returned ONCE": DISTINCT ON (tr.id) collapses the per-edition rows
    // back to one row per talent, keeping the BEST-RANKED edition's snippet. Any
    // present text row is eligible (there is no edition hard-delete path; deleted
    // editions are not a concept — §15). The outer ORDER BY restores the global
    // ts_rank ordering after the per-talent DISTINCT ON de-duplication.
    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (tr.id) tr.*,
               ts_headline('english', rt.redacted_text,
                 websearch_to_tsquery('english', $1),
                 'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=5,MaxWords=18'
               ) AS resume_snippet,
               ts_rank(rt.search_tsv, websearch_to_tsquery('english', $1)) AS resume_rank
        FROM "talent_record"."TalentRecord" tr
        JOIN "talent_record"."talent_resume_text" rt
          ON rt.talent_record_id = tr.id
        WHERE ${conds.join(' AND ')}
        ORDER BY tr.id, resume_rank DESC
      ) ranked
      ORDER BY ranked.resume_rank DESC
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
        // TR-2a-B3a (DDR-3 §3) — count is the cardinality of the tenant-facing
        // list surface, so it shares list()'s live-only default: a superseded
        // record is not counted where it would not be listed.
        record_status: 'live',
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateTalentRecordRequestDto;
    requestId: string;
    // ATI-SEP-1 A3 — evidence areas the same request also edits (e.g.
    // 'work_history'), named on the talent.profile_updated row.
    extra_changed_fields?: readonly string[];
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
    assertStatedFields(i, args.requestId);
    assertDateAvailable(i, args.requestId);
    const data: Record<string, unknown> = {};
    if (i.first_name !== undefined) data['first_name'] = i.first_name;
    if (i.last_name !== undefined) data['last_name'] = i.last_name;
    if (i.email1 !== undefined) data['email1'] = i.email1;
    if (i.email2 !== undefined) data['email2'] = i.email2;
    if (i.phone_home !== undefined) data['phone_home'] = i.phone_home;
    if (i.phone_cell !== undefined) {
      data['phone_cell'] = i.phone_cell;
      data['phone_cell_normalized'] = normalizePhoneForDedupe(i.phone_cell);
    }
    if (i.phone_work !== undefined) data['phone_work'] = i.phone_work;
    if (i.address !== undefined) data['address'] = i.address;
    if (i.address2 !== undefined) data['address2'] = i.address2;
    if (i.city !== undefined) data['city'] = i.city;
    if (i.state !== undefined) data['state'] = i.state;
    if (i.zip !== undefined) data['zip'] = i.zip;
    if (i.country !== undefined) data['country'] = i.country;
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
    if (i.title !== undefined) data['title'] = i.title;
    if (i.availability_status !== undefined) data['availability_status'] = i.availability_status;
    if (i.engagement_type !== undefined) data['engagement_type'] = i.engagement_type;
    if (i.work_authorization !== undefined) data['work_authorization'] = i.work_authorization;
    if (i.owner_id !== undefined) data['owner_id'] = i.owner_id;

    // ATI-SEP-1 A3 — the update and its talent.profile_updated row commit
    // together; a no-op PATCH (nothing changed) emits nothing.
    const changed = [
      ...Object.keys(data).filter((k) => k !== 'phone_cell_normalized'),
      ...(args.extra_changed_fields ?? []),
    ];
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.talentRecord.update({
        where: { id: args.id },
        data,
      });
      if (changed.length > 0) {
        const event: TalentEventInput = {
          tenant_id: args.tenant_id,
          event_type: TALENT_EVENT_PROFILE_UPDATED,
          talent_record_id: args.id,
          changed_fields: changed,
          correlation_id: args.requestId !== '' ? args.requestId : null,
        };
        await writeTalentEvent(tx as unknown as TalentEventOutboxWriter, event);
      }
      return updated;
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
    // ATI-SEP-1 A3 — the delete and its talent.deleted row commit together.
    await this.prisma.$transaction(async (tx) => {
      await tx.talentRecord.delete({ where: { id: args.id } });
      await writeTalentEvent(tx as unknown as TalentEventOutboxWriter, {
        tenant_id: args.tenant_id,
        event_type: TALENT_EVENT_DELETED,
        talent_record_id: args.id,
        correlation_id: args.requestId !== '' ? args.requestId : null,
      });
    });
  }

  // TR-2a-B3b (DDR-3 §2/§3) — the supersession WRITER (the B3a record_status axis
  // finally gets its producer). Marks R_L as superseded by the surviving record
  // R_S: record_status='superseded' + superseded_by_record_id + superseded_at.
  // Supersession is NOT deletion — the row persists with full content (un-merge
  // restore source + honest history). Tenant-scoped + row-scoped. Idempotent: a
  // re-run (resume) sets the same values. Returns the affected id or null (missing
  // or cross-tenant → no-op, the caller treats absent R_L as already-handled).
  async supersedeRecord(args: {
    tenant_id: string;
    id: string;
    superseded_by_record_id: string;
    superseded_at?: Date;
  }): Promise<{ id: string } | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: {
        record_status: 'superseded',
        superseded_by_record_id: args.superseded_by_record_id,
        superseded_at: args.superseded_at ?? new Date(),
      },
    });
    return result.count > 0 ? { id: args.id } : null;
  }

  // TR-2a-B3b (DDR-3 §6) — reversal lifts supersession: record_status→'live',
  // pointer + timestamp cleared. Idempotent (a re-run sets the same live state).
  async restoreRecord(args: { tenant_id: string; id: string }): Promise<{ id: string } | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: { record_status: 'live', superseded_by_record_id: null, superseded_at: null },
    });
    return result.count > 0 ? { id: args.id } : null;
  }

  // -------------------------------------------------------------------------
  // PR-A5b-2 — cluster-link write surface (data-only).
  //
  // setLink / clearLink are PRIMITIVE column writes — no cross-lib
  // validation lives here. The cluster-exists check is run by
  // TalentLinkService BEFORE calling these methods. Both calls are
  // tenant-scoped at the row level (WHERE id = :id AND tenant_id = :t)
  // so a controller mistake cannot set the link on a row from a
  // different tenant.
  // -------------------------------------------------------------------------

  // 4e-rest: SERVER-ONLY link-state read for TalentLinkService. Returns just
  // the tenant-local id + the PERSON_CLUSTER pointer via a MINIMAL select —
  // never widen it. cluster_id is a cross-tenant id, so it is exposed only on
  // this internal accessor, never on findById / projectView / TalentRecordView.
  // The service uses findById for existence/404 and findLinkState for the link
  // reads (idempotency, already-linked guard, is_linked).
  async findLinkState(args: {
    tenant_id: string;
    id: string;
  }): Promise<{ id: string; cluster_id: string | null } | null> {
    return this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true, cluster_id: true },
    });
  }

  // 4e-rest-b: SERVER-ONLY portal self-profile read. Tenant-scoped, MINIMAL
  // select of exactly the fields the portal profile projects — never widen it.
  // TalentRecordService.findSelfProfile null-guards + shapes the projection;
  // this is the raw row (nullable tenant_status / source_channel surfaced so
  // the service can enforce the un-statused → 404 policy).
  async findPortalProfileRow(args: {
    tenant_id: string;
    id: string;
  }): Promise<{
    id: string;
    tenant_id: string;
    tenant_status: string | null;
    source_channel: string | null;
    created_at: Date;
  } | null> {
    return this.prisma.talentRecord.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: {
        id: true,
        tenant_id: true,
        tenant_status: true,
        source_channel: true,
        created_at: true,
      },
    });
  }

  // Gate-1 G1-B — tenant-scoped getter for a talent's REDACTED resume body
  // (TalentResumeText.redacted_text; already PII-redacted at persist per D4).
  // The examine endpoint feeds this (+ key_skills) to TalentExtractionService.
  // Returns null when the talent has no resume text row / no extracted body.
  //
  // TI-1H — the table is now per-edition (many rows per talent). This talent-
  // level read preserves the pre-TI-1H "the talent's resume text" behavior by
  // returning the MOST-RECENTLY-EXTRACTED body DETERMINISTICALLY (was an
  // orderBy-less findFirst — nondeterministic once multiple editions exist).
  // Per-edition preview is findResumeEditionText().
  async findResumeRedactedText(args: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<string | null> {
    const row = await this.prisma.talentResumeText.findFirst({
      where: {
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        redacted_text: { not: null },
      },
      orderBy: [
        { extracted_at: { sort: 'desc', nulls: 'last' } },
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      select: { redacted_text: true },
    });
    return row?.redacted_text ?? null;
  }

  // TI-1H §9 — per-edition preview. Returns the redacted text + status for ONE
  // resume edition's own row (tenant-scoped). null when the talent/tenant has no
  // text row for that edition (edition never extracted, or not this tenant's).
  // Reading edition R returns R's text — never another edition's (§9).
  async findResumeEditionText(args: {
    tenant_id: string;
    talent_record_id: string;
    resume_edition_id: string;
  }): Promise<{ redacted_text: string | null; status: string; extracted_at: Date | null } | null> {
    const row = await this.prisma.talentResumeText.findFirst({
      where: {
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        resume_edition_id: args.resume_edition_id,
      },
      select: { redacted_text: true, status: true, extracted_at: true },
    });
    if (row === null) return null;
    return {
      redacted_text: row.redacted_text ?? null,
      status: row.status,
      extracted_at: row.extracted_at ?? null,
    };
  }

  // 4e-rest: cluster-only link write (the former identity-link column was
  // dropped). Writes the PERSON_CLUSTER pointer; tenant-scoped at the row
  // level so a controller mistake cannot link a row from a different tenant.
  async setLink(args: {
    tenant_id: string;
    id: string;
    cluster_id: string;
  }): Promise<{ id: string; cluster_id: string | null } | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: { cluster_id: args.cluster_id },
    });
    if (result.count === 0) {
      // Row was not in tenant (or vanished) — caller handles as
      // NOT_FOUND. We don't throw here so the read-after-write below
      // is the single fetch point. Returns link-state only (no
      // tenant-visible view — cluster_id is server-only).
      return null;
    }
    return this.findLinkState({ tenant_id: args.tenant_id, id: args.id });
  }

  async clearLink(args: {
    tenant_id: string;
    id: string;
  }): Promise<{ id: string; cluster_id: string | null } | null> {
    const result = await this.prisma.talentRecord.updateMany({
      where: { id: args.id, tenant_id: args.tenant_id },
      data: { cluster_id: null },
    });
    if (result.count === 0) {
      return null;
    }
    return this.findLinkState({ tenant_id: args.tenant_id, id: args.id });
  }
}
