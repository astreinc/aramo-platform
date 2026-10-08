// ADR-0033 — the Talent Intake processing port.
//
// The runtime-neutral TalentIntakeMessageHandler depends on THIS port, not on
// any concrete processor. It wraps the EXISTING, unchanged CAS-claimed idempotent
// processing path (processIntakeDraft → runIntakeExtraction) — no duplication.
//
// During migration the BullMQ ResumeExtractionDraftProcessor satisfies this port;
// at cutover (retiring the BullMQ intake transport) the same logic moves to a
// plain, BullMQ-free service that implements this identical port, so the Lambda
// runtime never pulls in BullMQ/Redis. The handler is unaffected either way.

export const TALENT_INTAKE_PROCESSING_PORT = 'TALENT_INTAKE_PROCESSING_PORT';

export interface TalentIntakeProcessingPort {
  // Idempotently process ONE claimed intake draft: short-circuit if not QUEUED,
  // CAS-claim (version guard), run the governed extraction, persist child then
  // parent. Returns true if THIS call claimed + ran; false for an idempotent
  // no-op (already claimed/terminal). MUST NOT throw for an extraction failure
  // (that is persisted as a terminal FAILED/PARTIAL state); a throw signals a
  // transient/infra error the caller may retry.
  processIntakeDraft(input: {
    draft_id: string;
    tenant_id: string;
    correlation_id?: string | null;
  }): Promise<boolean>;
}
