import { Injectable, Logger } from '@nestjs/common';
import type { VisibilityContextShape } from '@aramo/common';

import type { ActivityView } from './dto/activity.view.js';
import type { ActivityType } from './dto/activity-type.js';
import type { CreateActivityRequestDto } from './dto/create-activity-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// ActivityRepository — write + read surface for Activity.
//
// The HTTP-driven `create(...)` path is the recruiter-authored manual
// surface (kinds: note | call | email_logged). The programmatic
// pipeline-transition path goes through `insertActivityInTx` (a raw-SQL
// helper exported from this lib that mirrors @aramo/metering's
// recordUsage) — it is composed into the pipeline transition's
// $transaction so the Activity row commits iff the pipeline state
// change commits (PR-A1c Ruling 6 atomicity, applied to activity).

interface ActivityRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  type: ActivityType;
  subject_type: string | null;
  subject_id: string | null;
  notes: string | null;
  created_by_id: string | null;
  created_at: Date;
}

function projectView(row: ActivityRow): ActivityView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    type: row.type,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    notes: row.notes,
    created_by_id: row.created_by_id,
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class ActivityRepository {
  private readonly logger = new Logger(ActivityRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Write path — manual recruiter entries (HTTP)
  // -------------------------------------------------------------------------

  async create(args: {
    tenant_id: string;
    created_by_id: string;
    input: CreateActivityRequestDto;
  }): Promise<ActivityView> {
    const row = await this.prisma.activity.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        type: args.input.type,
        subject_type: args.input.subject_type ?? null,
        subject_id: args.input.subject_id ?? null,
        notes: args.input.notes ?? null,
        created_by_id: args.created_by_id,
      },
    });
    return projectView(row as ActivityRow);
  }

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ActivityView | null> {
    const row = await this.prisma.activity.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as ActivityRow);
  }

  /**
   * List activity. When `subject_type` + `subject_id` are both supplied,
   * scopes to the polymorphic subject (e.g. activity for one Pipeline);
   * otherwise returns the recent tenant stream. A partial filter (only
   * one of the two) is ignored at the where-clause level so that the
   * read remains permissive — the controller-side ValidationPipe
   * already strips unknown queries on the route.
   */
  async list(args: {
    tenant_id: string;
    subject_type?: string;
    subject_id?: string;
    limit?: number;
  }): Promise<ActivityView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const bothSubjectFiltersProvided =
      args.subject_type !== undefined && args.subject_id !== undefined;
    const rows = await this.prisma.activity.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(bothSubjectFiltersProvided
          ? { subject_type: args.subject_type, subject_id: args.subject_id }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as ActivityRow[]).map(projectView);
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: { tenant_id: string }): Promise<number> {
    return this.prisma.activity.count({
      where: { tenant_id: args.tenant_id },
    });
  }

  // Segment 3 — BATCH read for the talent-records list enrichment (the
  // last_activity_at read-model). Set-based over the page's id set (one
  // groupBy query, never per-row). talent_record activities are pool-open
  // (the §5 boundary), so this is tenant-wide — no visibility filter.
  // Returns talent_record_id → most-recent activity timestamp (ISO); ids with
  // no activity are simply absent from the map.
  async findLastActivityForTalentIds(args: {
    tenant_id: string;
    talent_record_ids: readonly string[];
  }): Promise<Map<string, string>> {
    if (args.talent_record_ids.length === 0) return new Map();
    const rows = await this.prisma.activity.groupBy({
      by: ['subject_id'],
      where: {
        tenant_id: args.tenant_id,
        subject_type: 'talent_record',
        subject_id: { in: [...args.talent_record_ids] },
      },
      _max: { created_at: true },
    });
    const out = new Map<string, string>();
    for (const r of rows) {
      const ts = r._max.created_at;
      if (r.subject_id !== null && ts !== null) {
        out.set(r.subject_id, ts.toISOString());
      }
    }
    return out;
  }

  // AUTHZ-D4b — visibility-scoped read paths.
  //
  // Activity is the POLYMORPHIC entity — subject_type discriminates the
  // visibility resolution:
  //   - 'pipeline'      → subject_id ∈ visible_pipeline_ids
  //   - 'requisition'   → subject_id ∈ visible_requisition_ids
  //   - 'company'       → subject_id ∈ visible_client_ids
  //   - 'talent_record' → UNRESTRICTED (pool-open per the §5 boundary —
  //                       a talent note is a talent read; tenant-wide)
  //
  // Implemented as a single Prisma `where` (one query-layer OR per
  // DDR D6 — NO post-query filter, NO leak risk). When the actor has
  // see_all_company AND see_all_requisition, the visibility OR is
  // dropped entirely (every row is visible).
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visibility: VisibilityContextShape;
    visible_requisition_ids: ReadonlySet<string> | null;
    visible_pipeline_ids: ReadonlySet<string> | null;
  }): Promise<ActivityView | null> {
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      id: args.id,
      ...buildActivityVisibilityWhere({
        visibility: args.visibility,
        visible_requisition_ids: args.visible_requisition_ids,
        visible_pipeline_ids: args.visible_pipeline_ids,
      }),
    };
    const row = await this.prisma.activity.findFirst({ where });
    return row === null ? null : projectView(row as ActivityRow);
  }

  async listForActor(args: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    visible_requisition_ids: ReadonlySet<string> | null;
    visible_pipeline_ids: ReadonlySet<string> | null;
    subject_type?: string;
    subject_id?: string;
    limit?: number;
  }): Promise<ActivityView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const bothSubjectFiltersProvided =
      args.subject_type !== undefined && args.subject_id !== undefined;
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      ...(bothSubjectFiltersProvided
        ? { subject_type: args.subject_type, subject_id: args.subject_id }
        : {}),
      ...buildActivityVisibilityWhere({
        visibility: args.visibility,
        visible_requisition_ids: args.visible_requisition_ids,
        visible_pipeline_ids: args.visible_pipeline_ids,
      }),
    };
    const rows = await this.prisma.activity.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as ActivityRow[]).map(projectView);
  }
}

// Build the activity polymorphic visibility OR (query-layer per DDR D6).
// Returns {} when the actor has see-all for both company + requisition
// (no scoping needed). The `talent_record` subject_type is intentionally
// unrestricted (the §5 pool-open boundary). Empty IN-sets collapse the
// matching branch to "no match" — Prisma handles `in: []` correctly.
function buildActivityVisibilityWhere(args: {
  visibility: VisibilityContextShape;
  visible_requisition_ids: ReadonlySet<string> | null;
  visible_pipeline_ids: ReadonlySet<string> | null;
}): Record<string, unknown> {
  const seeAllCompany = args.visibility.see_all_company;
  const seeAllReq = args.visibility.see_all_requisition;
  if (seeAllCompany && seeAllReq) return {};

  const visibleClients = args.visibility.visible_client_ids;
  const visibleReqs = args.visible_requisition_ids;
  const visiblePipelines = args.visible_pipeline_ids;

  const branches: Array<Record<string, unknown>> = [];

  // pipeline branch
  if (visiblePipelines === null) {
    branches.push({ subject_type: 'pipeline' });
  } else {
    branches.push({
      subject_type: 'pipeline',
      subject_id: { in: Array.from(visiblePipelines) },
    });
  }

  // requisition branch
  if (visibleReqs === null) {
    branches.push({ subject_type: 'requisition' });
  } else {
    branches.push({
      subject_type: 'requisition',
      subject_id: { in: Array.from(visibleReqs) },
    });
  }

  // company branch
  if (seeAllCompany || visibleClients === null) {
    branches.push({ subject_type: 'company' });
  } else {
    branches.push({
      subject_type: 'company',
      subject_id: { in: Array.from(visibleClients) },
    });
  }

  // talent_record branch — UNRESTRICTED per §5 pool-open boundary.
  branches.push({ subject_type: 'talent_record' });

  return { OR: branches };
}
