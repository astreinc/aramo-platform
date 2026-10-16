import { Injectable } from '@nestjs/common';
import type {
  ScreeningAnalysisContextSource,
  ScreeningContextLoad,
  ScreeningDraftSinkResult,
  ScreeningFindingDraftSink,
} from '@aramo/conversation-intelligence';
import { ScreeningGuardError, TechnicalScreeningRepository } from '@aramo/technical-screening';

import { ScreeningContextReader } from '../technical-screening/screening-context.reader.js';

// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.1/D.2/D.3, §B.2)
// — the composition-root bindings of the CI screening-profile seams.
//   Context: exactly-one session → its Talent; the SELECTED question plan, the
//   recruiter notes and the minimized talent profile (D.2 evidence universe).
//   Sink: AI-drafted findings land as DRAFT review items (origin AI_DRAFTED,
//   evidence_source MEETING_TRANSCRIPT, basis SELF_REPORTED — what the talent
//   said, never recruiter-observed or demonstrated), idempotent on the CI run id.
//   Recruiter review happens in the screening domain; nothing here confirms or
//   publishes anything.

/** The non-human actor recorded on system-drafted screening rows. */
export const SCREENING_CI_SYSTEM_ACTOR = 'system:conversation-intelligence';

@Injectable()
export class ScreeningAnalysisContextAdapter implements ScreeningAnalysisContextSource {
  constructor(
    private readonly repo: TechnicalScreeningRepository,
    private readonly reader: ScreeningContextReader,
  ) {}

  async load(tenantId: string, sessionId: string): Promise<ScreeningContextLoad> {
    const session = await this.repo.findSession(tenantId, sessionId);
    if (session === null) return { status: 'not_found' };
    if (session.state !== 'DRAFT') return { status: 'not_draft' };
    const [questions, notes, profile] = await Promise.all([
      this.repo.listQuestions(tenantId, sessionId),
      this.repo.listNotes(tenantId, sessionId),
      this.reader.talentContext({ tenant_id: tenantId, talent_record_id: session.talent_record_id }),
    ]);
    return {
      status: 'ready',
      context: {
        session_id: session.id,
        talent_record_id: session.talent_record_id,
        interaction_id: session.interaction_id,
        question_plan: questions.filter((q) => q.status === 'SELECTED').map((q) => q.text),
        recruiter_notes: notes.map((n) => n.body),
        talent_profile: profile,
      },
    };
  }
}

@Injectable()
export class ScreeningFindingDraftSinkAdapter implements ScreeningFindingDraftSink {
  constructor(private readonly repo: TechnicalScreeningRepository) {}

  async saveDrafts(input: Parameters<ScreeningFindingDraftSink['saveDrafts']>[0]): Promise<ScreeningDraftSinkResult> {
    try {
      const saved = await this.repo.saveAiDraftedFindings({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        actor_id: SCREENING_CI_SYSTEM_ACTOR,
        generation_id: input.run_id,
        generation: {
          kind: 'FINDINGS_DRAFT',
          provider: input.provenance.provider,
          model: input.provenance.model,
          provider_request_id: input.provenance.provider_request_id,
          prompt_version: input.provenance.prompt_version,
          input_sha256: input.provenance.input_sha256,
          used_talent_profile: input.provenance.used_talent_profile,
          used_requisition: input.provenance.used_requisition,
          used_transcript: true,
        },
        findings: input.findings.map((f) => ({
          skill_raw: f.skill,
          basis: 'SELF_REPORTED',
          observation_raw: f.observation,
          limitations_raw: f.limitations,
          evidence_source: 'MEETING_TRANSCRIPT',
          citations: f.citations.map((c) => ({ ...c })),
        })),
      });
      return saved.replayed ? 'replayed' : 'saved';
    } catch (err) {
      if (err instanceof ScreeningGuardError) {
        return err.reason === 'not_found' ? 'session_not_found' : 'session_not_draft';
      }
      throw err;
    }
  }
}
