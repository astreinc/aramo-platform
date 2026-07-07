import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { TalentTrustRepository } from '@aramo/talent-trust';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  STALE_PENDING_ADVISORY_AGE_MS,
  STALE_PENDING_OPERATION_AGE_MS,
} from './identity-detection.queue.constants.js';

// TR-6 B1 (DDR §7) — recurring integrity detection (REPORT-ONLY). Four cheap
// detector classes (Q4); the cron logs a structured line per class + per-class
// counts and MUTATES NOTHING (every query is a read). Humans act on the reports
// (the resume command is the tool for orphaned reconciles); there is no dashboard
// and no auto-remediation in TR-6.
//
//   1. two-live-record clusters — a MERGED subject whose survivor is ACTIVE and
//      where BOTH still carry a LIVE TalentRecord (two live records for one human).
//   2. crash-orphaned reconciles — SubjectMergeOperation PENDING beyond age.
//   3. reviewer backlog — PENDING_REVIEW advisories beyond age.
//   4. husk still receiving writes — a MERGED subject with an anchor/evidence row
//      created after it was merged (a stale ref writing to the old subject).

export interface DetectionReport {
  two_live_record_clusters: number;
  stale_pending_operations: number;
  stale_pending_advisories: number;
  merged_subjects_receiving_writes: number;
}

@Injectable()
export class IdentityDetectionService {
  constructor(
    private readonly trustRepo: TalentTrustRepository,
    private readonly talentRecords: TalentRecordRepository,
    @Inject('IdentityDetectionServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  // Run every detector once and return the per-class counts. `now` is injectable so
  // the acceptance spec can seed rows and pin the age boundary deterministically.
  async runDetection(now: Date = new Date()): Promise<DetectionReport> {
    const report: DetectionReport = {
      two_live_record_clusters: await this.detectTwoLiveRecordClusters(now),
      stale_pending_operations: await this.detectStalePendingOperations(now),
      stale_pending_advisories: await this.detectStalePendingAdvisories(now),
      merged_subjects_receiving_writes: await this.detectMergedSubjectsReceivingWrites(now),
    };
    this.logger.log({ event: 'identity_detection_run_completed', ...report });
    return report;
  }

  private async detectTwoLiveRecordClusters(_now: Date): Promise<number> {
    const pairs = await this.trustRepo.findAllMergedPromotedPairs();
    let count = 0;
    for (const p of pairs) {
      // Confirm BOTH records are still LIVE (a since-reconciled pair is not stale).
      const merged = await this.talentRecords.findById({
        tenant_id: p.tenant_id,
        id: p.merged_record_id,
      });
      const surviving = await this.talentRecords.findById({
        tenant_id: p.tenant_id,
        id: p.surviving_record_id,
      });
      if (
        merged !== null &&
        surviving !== null &&
        merged.record_status !== 'superseded' &&
        surviving.record_status !== 'superseded'
      ) {
        count += 1;
        this.logger.warn({
          event: 'detection_two_live_record_cluster',
          tenant_id: p.tenant_id,
          merged_subject_id: p.merged_subject_id,
          surviving_subject_id: p.surviving_subject_id,
        });
      }
    }
    return count;
  }

  private async detectStalePendingOperations(now: Date): Promise<number> {
    const olderThan = new Date(now.getTime() - STALE_PENDING_OPERATION_AGE_MS);
    const rows = await this.trustRepo.findStalePendingOperations(olderThan);
    for (const r of rows) {
      this.logger.warn({
        event: 'detection_stale_pending_operation',
        tenant_id: r.tenant_id,
        operation_id: r.id,
        kind: r.kind,
      });
    }
    return rows.length;
  }

  private async detectStalePendingAdvisories(now: Date): Promise<number> {
    const olderThan = new Date(now.getTime() - STALE_PENDING_ADVISORY_AGE_MS);
    const rows = await this.trustRepo.findStalePendingAdvisories(olderThan);
    for (const r of rows) {
      this.logger.warn({
        event: 'detection_stale_pending_advisory',
        tenant_id: r.tenant_id,
        advisory_id: r.id,
      });
    }
    return rows.length;
  }

  private async detectMergedSubjectsReceivingWrites(_now: Date): Promise<number> {
    const rows = await this.trustRepo.findMergedSubjectsWithPostMergeWrites();
    for (const r of rows) {
      this.logger.warn({
        event: 'detection_merged_subject_receiving_writes',
        tenant_id: r.tenant_id,
        subject_id: r.subject_id,
      });
    }
    return rows.length;
  }
}
