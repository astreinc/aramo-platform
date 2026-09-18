import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';
import {
  SkillCorrectionTaskRepository,
  type SkillCorrectionTaskRow,
} from '@aramo/skills-taxonomy';
import { TalentCanonicalCorrectionRepository } from '@aramo/talent-evidence';
import { RequisitionSkillRequirementRepository } from '@aramo/requisition';

// SKILL-TAX-1F-B1 — the durable correction/propagation processor. Lives in apps/api
// (the only place that may legally touch skills-taxonomy + talent-evidence
// (scope:cip) AND requisition (scope:ats)). It DRAINS the durable SkillCorrectionTask
// ledger — created atomically with each governance mutation — and performs the
// downstream correction the mutation owes:
//   • SKILL_MERGE: deterministic canonical repoint (loser → winner) in BOTH domains
//     + a TARGETED re-reconcile of exactly the affected Talents/golden-profiles.
//   • ALIAS/OVERRIDE corrections: targeted re-reconcile only (no repoint).
// Contracts (Gate-6 ruling): the claim is exclusive (FOR UPDATE SKIP LOCKED, in the
// repo) so no duplicate processing; every step is idempotent; a task is COMPLETED
// ONLY after both the domain correction AND the required reconcile enqueue succeed;
// partial failure returns the task to PENDING (retryable) until MAX_ATTEMPTS, then
// FAILED (terminal, observable). This is NOT a global sweep and does NOT touch the
// activation watermark backstop.
const MAX_ATTEMPTS = 5;
const FANOUT_LIMIT = 1000;

export interface DrainSummary {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

@Injectable()
export class SkillCorrectionProcessor {
  constructor(
    private readonly tasks: SkillCorrectionTaskRepository,
    private readonly talentCorrection: TalentCanonicalCorrectionRepository,
    private readonly requisitionRequirements: RequisitionSkillRequirementRepository,
    private readonly producer: CanonicalReconcileProducer,
    @Inject('SkillCorrectionProcessorLogger') private readonly logger: AramoLogger,
  ) {}

  // Drain up to maxTasks PENDING corrections. Each claim is exclusive; a claimed
  // task whose attempts already exceed MAX_ATTEMPTS is failed without re-processing.
  async drain(maxTasks = 50): Promise<DrainSummary> {
    const summary: DrainSummary = { claimed: 0, completed: 0, retried: 0, failed: 0 };
    // Two-phase: CLAIM all currently-PENDING tasks up front (each atomically flips
    // to IN_PROGRESS, so the same task is never claimed twice in one pass), THEN
    // process. A retryable failure returns the task to PENDING only AFTER the claim
    // phase, so it is retried on the NEXT drain (one attempt per task per tick),
    // never burned through its whole retry budget inside a single drain.
    const claimed: SkillCorrectionTaskRow[] = [];
    for (let i = 0; i < maxTasks; i += 1) {
      const task = await this.tasks.claimNextPending();
      if (task === null) break;
      claimed.push(task);
    }
    for (const task of claimed) {
      summary.claimed += 1;
      if (task.attempts > MAX_ATTEMPTS) {
        await this.tasks.markFailed(task.id, `exceeded ${MAX_ATTEMPTS} attempts`);
        summary.failed += 1;
        continue;
      }
      try {
        await this.process(task);
        await this.tasks.markCompleted(task.id);
        summary.completed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (task.attempts >= MAX_ATTEMPTS) {
          await this.tasks.markFailed(task.id, msg);
          summary.failed += 1;
        } else {
          await this.tasks.markRetryable(task.id, msg);
          summary.retried += 1;
        }
        this.logger.warn({ event: 'skill_correction_task_failed', task_id: task.id, error: msg });
      }
    }
    if (summary.claimed > 0) {
      this.logger.log({ event: 'skill_correction_drain', ...summary });
    }
    return summary;
  }

  // Process one task. Throws on any failure so drain() marks it retryable/failed;
  // returns only when EVERY correction + enqueue succeeded (COMPLETED gate).
  private async process(task: SkillCorrectionTaskRow): Promise<void> {
    if (task.correction_type === 'SKILL_MERGE') {
      const from = task.from_canonical_skill_id;
      const to = task.to_canonical_skill_id;
      if (from === null || to === null) {
        throw new Error('SKILL_MERGE task missing from/to canonical id');
      }
      // Discover the affected set BEFORE the repoint (rows still keyed to the loser)
      // so the re-reconcile fan-out is exactly the impacted Talents/golden-profiles.
      const talents = await this.talentCorrection.findAffectedTalents({
        canonicalSkillIds: [from],
        limit: FANOUT_LIMIT,
      });
      const goldenProfiles = await this.requisitionRequirements.findAffectedGoldenProfiles({
        canonicalSkillIds: [from],
        limit: FANOUT_LIMIT,
      });
      // 1. Deterministic repoint loser → winner in both domains (idempotent).
      await this.talentCorrection.repointCanonicalSkillId(from, to);
      await this.requisitionRequirements.repointCanonicalSkillId(from, to);
      // 2. Targeted re-reconcile of exactly the affected rows (the recomputation
      //    layer — NOT a substitute for the repoint). Both protections retained.
      await this.enqueue(talents, goldenProfiles);
      return;
    }
    // ALIAS_CORRECTION / OVERRIDE_CORRECTION — re-reconcile the affected surface only.
    const surface = task.surface_form;
    if (surface === null) {
      throw new Error(`${task.correction_type} task missing surface_form`);
    }
    const talents = await this.talentCorrection.findAffectedTalents({
      surfaceForms: [surface],
      limit: FANOUT_LIMIT,
    });
    const goldenProfiles = await this.requisitionRequirements.findAffectedGoldenProfiles({
      surfaceForms: [surface],
      limit: FANOUT_LIMIT,
    });
    await this.enqueue(talents, goldenProfiles);
  }

  private async enqueue(
    talents: ReadonlyArray<{ tenant_id: string; talent_id: string }>,
    goldenProfiles: ReadonlyArray<{ tenant_id: string; requisition_id: string; golden_profile_id: string }>,
  ): Promise<void> {
    // COMPLETED gate: use the REQUIRED (non-swallowing) enqueue variants so a
    // missing Redis OR an individual queue.add failure THROWS — the task then stays
    // PENDING/retryable instead of being falsely COMPLETED with a vanished
    // re-reconcile. The repoints are idempotent, so re-running on the next tick is
    // safe. (The best-effort enqueue* methods remain for business-write callers.)
    for (const t of talents) {
      await this.producer.enqueueTalentRequired(t.tenant_id, t.talent_id);
    }
    for (const g of goldenProfiles) {
      await this.producer.enqueueRequisitionRequired(g.tenant_id, g.requisition_id, g.golden_profile_id);
    }
  }
}
