import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// SKILL-TAX-1F-B1 — persistence for the durable correction/propagation work ledger
// (SkillCorrectionTask). The ledger is created ATOMICALLY with the governance
// mutation (see SkillRepository.mergeSkill); this repository owns the drain side:
// an atomic claim that prevents concurrent duplicate processing, plus bounded,
// observable completion / retry / failure. INSERT of new tasks happens inside the
// mutation transaction, NOT here.

export type CorrectionType = 'SKILL_MERGE' | 'ALIAS_CORRECTION' | 'OVERRIDE_CORRECTION';
export type CorrectionStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface SkillCorrectionTaskRow {
  id: string;
  correction_type: CorrectionType;
  from_canonical_skill_id: string | null;
  to_canonical_skill_id: string | null;
  surface_form: string | null;
  status: CorrectionStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

@Injectable()
export class SkillCorrectionTaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Atomically claim the oldest PENDING task: flip it to IN_PROGRESS + bump
  // attempts, selecting the row with FOR UPDATE SKIP LOCKED so two concurrent
  // processors never claim the same task (no duplicate propagation). Returns the
  // claimed row, or null when the queue is empty. Single round-trip.
  async claimNextPending(): Promise<SkillCorrectionTaskRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<SkillCorrectionTaskRow[]>(
      `UPDATE "skills_taxonomy"."SkillCorrectionTask" t
          SET "status" = 'IN_PROGRESS',
              "attempts" = t."attempts" + 1,
              "updated_at" = now()
        WHERE t."id" = (
          SELECT s."id"
            FROM "skills_taxonomy"."SkillCorrectionTask" s
           WHERE s."status" = 'PENDING'
           ORDER BY s."created_at" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING t.*`,
    );
    return rows.length > 0 ? rows[0]! : null;
  }

  // Terminal success — only after BOTH the domain repoint AND the required
  // reconciliation enqueue have succeeded (the processor enforces that ordering).
  async markCompleted(id: string): Promise<void> {
    await this.prisma.skillCorrectionTask.update({
      where: { id },
      data: { status: 'COMPLETED', completed_at: new Date() },
    });
  }

  // Retryable failure — return the task to PENDING with the error recorded, so a
  // later drain re-claims it (partial failure must remain recoverable).
  async markRetryable(id: string, error: string): Promise<void> {
    await this.prisma.skillCorrectionTask.update({
      where: { id },
      data: { status: 'PENDING', last_error: error.slice(0, 2000) },
    });
  }

  // Terminal failure — attempts exhausted. Stays observable (status + last_error).
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.skillCorrectionTask.update({
      where: { id },
      data: { status: 'FAILED', last_error: error.slice(0, 2000) },
    });
  }

  async findById(id: string): Promise<SkillCorrectionTaskRow | null> {
    const row = await this.prisma.skillCorrectionTask.findUnique({ where: { id } });
    return (row as SkillCorrectionTaskRow | null) ?? null;
  }

  // Observability — counts by status (governance telemetry; no global sweep).
  async countByStatus(): Promise<Record<CorrectionStatus, number>> {
    const rows = await this.prisma.skillCorrectionTask.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const out: Record<CorrectionStatus, number> = {
      PENDING: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      FAILED: 0,
    };
    for (const r of rows) out[r.status as CorrectionStatus] = r._count._all;
    return out;
  }
}
