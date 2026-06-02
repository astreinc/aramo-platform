import { Injectable, Logger } from '@nestjs/common';

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
}
