import { v7 as uuidv7 } from 'uuid';

import type { ActivityType } from './dto/activity-type.js';

// PR-A5a — insertActivityInTx helper.
//
// Mirrors the @aramo/metering recordUsage helper pattern (PR-A1c §2):
// returns a PrismaPromise from $executeRaw that the CALLER composes into
// its existing $transaction([...]) array. Because the project uses ONE
// Postgres database for all schemas, the cross-schema $executeRaw INSERT
// into activity."Activity" runs in the same PG transaction as the
// caller's other writes — atomicity guaranteed (Ruling 6: the Activity
// row commits iff the caller's transaction commits).
//
// Why a raw helper instead of a repository method: keeping libs/activity
// a true leaf (no per-domain Prisma-model dependency edge). The pipeline
// transition needs the Activity write to land in the SAME transaction as
// the Pipeline.status update + the PipelineStatusHistory insert + the
// metering event — that means the SAME Prisma client (pipeline's
// PrismaService), and the simplest path is a raw INSERT keyed by
// fully-qualified table name. The recordUsage helper proved this
// pattern at PR-A1c; this is its second application.
//
// The `prisma` argument is structurally typed (any object with
// `$executeRaw`). Each domain repository injects its own per-module
// PrismaService; passing it here keeps activity a true leaf (no
// back-edge into any caller — activity.module does not import
// @aramo/pipeline; the pipeline → activity edge is one-way).

export interface InsertActivityInput {
  tenant_id: string;
  site_id?: string;
  type: ActivityType;
  subject_type?: string;
  subject_id?: string;
  notes?: string;
  created_by_id?: string;
}

interface PrismaRawCapable {
  $executeRaw: (
    template: TemplateStringsArray,
    ...values: unknown[]
  ) => unknown;
}

export function insertActivityInTx<T extends PrismaRawCapable>(
  prisma: T,
  input: InsertActivityInput,
): ReturnType<T['$executeRaw']> {
  const id = uuidv7();
  // Nullable columns: bind null directly. Postgres infers the parameter
  // type from the INSERT target column at prepare time, so NULL into a
  // UUID column does not require an explicit `::uuid` cast on the
  // parameter (which would otherwise reject NULL bindings in some
  // driver configurations). Non-null UUIDs do get an explicit cast for
  // the tenant_id channel — that one we know is always a string.
  const site_id = input.site_id ?? null;
  const subject_type = input.subject_type ?? null;
  const subject_id = input.subject_id ?? null;
  const notes = input.notes ?? null;
  const created_by_id = input.created_by_id ?? null;
  return prisma.$executeRaw`
    INSERT INTO activity."Activity" (
      id, tenant_id, site_id, type, subject_type, subject_id, notes, created_by_id, created_at
    ) VALUES (
      ${id}::uuid,
      ${input.tenant_id}::uuid,
      ${site_id},
      ${input.type}::activity."ActivityType",
      ${subject_type},
      ${subject_id},
      ${notes},
      ${created_by_id},
      NOW()
    )
  ` as ReturnType<T['$executeRaw']>;
}
