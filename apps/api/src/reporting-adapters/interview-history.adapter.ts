import { Injectable } from '@nestjs/common';
import { InterviewSessionRepository } from '@aramo/client-selection';
import type {
  InterviewHistoryGrain,
  InterviewHistoryPort,
  InterviewHistoryQuery,
} from '@aramo/reporting';

// Lane 2 / L2-I (D4b) — the COMPOSITION-ROOT adapter implementing the reporting-owned
// InterviewHistoryPort with the authoritative @aramo/client-selection InterviewSession owner.
// This is the ONLY place the reporting interview-history semantic touches
// @aramo/client-selection: libs/reporting owns the port interface and imports no client-selection
// domain/repo/schema (the A7 seam — DEPENDENCY-ON-DATA yes, DIRECT-IMPORT no). The
// first-interview-per-grain MIN(scheduled_at) fold lives on the owner side
// (InterviewSessionRepository.findFirstInterviewByGrain). Mirrors the L2-E SubmittedHistoryAdapter.
@Injectable()
export class InterviewHistoryAdapter implements InterviewHistoryPort {
  constructor(private readonly sessions: InterviewSessionRepository) {}

  async findFirstInterviewByGrain(
    query: InterviewHistoryQuery,
  ): Promise<readonly InterviewHistoryGrain[]> {
    return this.sessions.findFirstInterviewByGrain({
      tenant_id: query.tenant_id,
      ...(query.requisition_ids === undefined
        ? {}
        : { requisition_ids: query.requisition_ids }),
    });
  }
}
