import { Injectable, Logger } from '@nestjs/common';
import { SourcedTalentRepository } from '@aramo/sourced-talent';
import {
  arrivalPhoneKey,
  phoneLookupForms,
  TalentDuplicateAdvisoryRepository,
  type DuplicateSharedKind,
} from '@aramo/talent-record';

// ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — the ATS-local within-tenant
// duplicate detector. Replaces the retired trust-ledger match sweep, the daily
// identity-detection cron and the match backfill: detection now runs off the ATS
// talent outbox (talent.created / talent.profile_updated, see
// DuplicateDetectionTalentEventHandler) and reads ATS data only.
//
// A record is compared against
//   (1) the OTHER live records of its tenant sharing its normalized primary email
//       or normalized cell phone → a PENDING_REVIEW pair advisory (basis EMAIL |
//       PHONE), and
//   (2) the tenant's sourced arrivals (not yet linked to a record) sharing either
//       → a PENDING_REVIEW SOURCED_ARRIVAL advisory, which gates that arrival's
//       promotion until a reviewer approves (same human → linked) or dismisses.
// Deterministic exact matching on normalized values; no fuzzy scoring, no
// automatic merge. Tenant-scoped by construction. Idempotent (the advisory
// unique keys), so an at-least-once event re-delivery is harmless.

export interface DetectionResult {
  pair_advisories_created: number;
  arrival_advisories_created: number;
}

@Injectable()
export class DuplicateDetectionService {
  private readonly logger = new Logger(DuplicateDetectionService.name);

  constructor(
    private readonly advisories: TalentDuplicateAdvisoryRepository,
    private readonly sourced: SourcedTalentRepository,
  ) {}

  async detectForRecord(tenantId: string, recordId: string): Promise<DetectionResult> {
    const out: DetectionResult = { pair_advisories_created: 0, arrival_advisories_created: 0 };
    const keys = await this.advisories.findRecordContactKeys(tenantId, recordId);
    // Erased / deleted / superseded records raise nothing.
    if (keys === null || keys.record_status !== 'live') return out;
    if (keys.email === null && keys.phone === null) return out;

    const matches = await this.advisories.findLiveContactMatches({
      tenant_id: tenantId,
      exclude_id: recordId,
      email: keys.email,
      phone: keys.phone,
    });
    for (const m of matches) {
      const created = await this.advisories.upsertPendingPair({
        tenant_id: tenantId,
        record_x: recordId,
        record_y: m.id,
        kinds: m.kinds,
      });
      if (created) out.pair_advisories_created += 1;
    }

    const arrivals = await this.sourced.findByNormalizedContact({
      tenant_id: tenantId,
      email: keys.email,
      phones: phoneLookupForms(keys.phone),
    });
    const linked = await this.advisories.findLinkedArrivalIds(
      tenantId,
      arrivals.map((a) => a.id),
    );
    for (const a of arrivals) {
      if (linked.has(a.id)) continue;
      const kinds: DuplicateSharedKind[] = [];
      if (keys.email !== null && a.normalized_email === keys.email) kinds.push('EMAIL');
      if (keys.phone !== null && arrivalPhoneKey(a.normalized_phone) === keys.phone) kinds.push('PHONE');
      const created = await this.advisories.upsertPendingArrival({
        tenant_id: tenantId,
        talent_record_id: recordId,
        sourced_talent_id: a.id,
        kinds,
      });
      if (created) out.arrival_advisories_created += 1;
    }

    if (out.pair_advisories_created + out.arrival_advisories_created > 0) {
      this.logger.log(
        `duplicate detection: record ${recordId} tenant ${tenantId} → ${out.pair_advisories_created} pair / ${out.arrival_advisories_created} arrival advisory(ies)`,
      );
    }
    return out;
  }

  /**
   * The arrival leg used by promotion when its create hits the tenant duplicate
   * guard: record a SOURCED_ARRIVAL advisory against the colliding live record so
   * a reviewer can confirm (link) or dismiss it. Idempotent.
   */
  async flagArrivalAgainstRecord(input: {
    tenant_id: string;
    sourced_talent_id: string;
    talent_record_id: string;
    kinds: readonly DuplicateSharedKind[];
  }): Promise<boolean> {
    return this.advisories.upsertPendingArrival({
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      sourced_talent_id: input.sourced_talent_id,
      kinds: input.kinds,
    });
  }
}
