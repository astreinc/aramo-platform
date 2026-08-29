import { Injectable } from '@nestjs/common';
import { TalentSubmittalEventRepository } from '@aramo/submittal';
import type {
  SubmittedHistoryGrain,
  SubmittedHistoryPort,
  SubmittedHistoryQuery,
} from '@aramo/reporting';

// Lane 2 / L2-E (SB-5 / D-4) — the COMPOSITION-ROOT adapter implementing the
// reporting-owned SubmittedHistoryPort with the authoritative @aramo/submittal
// event history. This is the ONLY place the reporting submitted-history semantic
// touches @aramo/submittal: libs/reporting owns the port interface + overlay and
// imports no submittal domain/repo/schema (Architect ruling Q3 — DEPENDENCY-ON-DATA
// yes, DIRECT-IMPORT no). The `to_state='submitted_to_ats'` predicate + the
// first-per-grain JOIN live on the submittal side (TalentSubmittalEventRepository).
@Injectable()
export class SubmittedHistoryAdapter implements SubmittedHistoryPort {
  constructor(private readonly events: TalentSubmittalEventRepository) {}

  async findFirstSubmittedByGrain(
    query: SubmittedHistoryQuery,
  ): Promise<readonly SubmittedHistoryGrain[]> {
    return this.events.findFirstSubmittedByGrain({
      tenant_id: query.tenant_id,
      ...(query.requisition_ids === undefined
        ? {}
        : { requisition_ids: query.requisition_ids }),
      ...(query.talent_ids === undefined ? {} : { talent_ids: query.talent_ids }),
      ...(query.since === undefined ? {} : { since: query.since }),
    });
  }
}
