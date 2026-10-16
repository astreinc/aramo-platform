import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import {
  ScreeningGuardError,
  TechnicalScreeningRepository,
  type ScreeningCitationRow,
  type ScreeningEventRow,
  type ScreeningFindingFields,
  type ScreeningFindingRow,
  type ScreeningGenerationRow,
  type ScreeningNoteRow,
  type ScreeningPublicationRow,
  type ScreeningQuestionRow,
  type ScreeningSessionRow,
  type ScreeningSuggestionRow,
  type ScreeningTranscriptLinkRow,
} from './technical-screening.repository.js';
import {
  SCREENING_EVIDENCE_PUBLISHER,
  type ScreeningEvidencePublisher,
} from './screening-publisher.port.js';
import {
  QUESTION_STATUSES,
  SCREENING_BASES,
  SCREENING_NOTE_MAX,
  SCREENING_QUESTION_MAX,
  SCREENING_SKILL_MAX,
  SCREENING_TEXT_MAX,
  SCREENING_VOID_REASON_MAX,
  SUGGESTION_ACTIONS,
} from './screening-vocab.js';

// TIP-E2E INC-3 — the Technical Screening domain service
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §5–§7). Authorization, entitlement, scope,
// consumer-type and talent tenant/site/liveness checks happen in apps/api BEFORE
// these calls; this service owns field validation, the lifecycle refusals and
// the publication state machine. Manual only — no LLM, nothing inferred.

export interface ScreeningFindingInput {
  skill_raw: unknown;
  basis: unknown;
  observation_raw: unknown;
  demonstration_raw?: unknown;
  limitations_raw?: unknown;
}

export interface ScreeningSessionDetail {
  session: ScreeningSessionRow;
  findings: ScreeningFindingRow[];
  publications: ScreeningPublicationRow[];
  // INC-3 A1.
  citations: ScreeningCitationRow[];
  questions: ScreeningQuestionRow[];
  notes: ScreeningNoteRow[];
  suggestions: ScreeningSuggestionRow[];
  generations: ScreeningGenerationRow[];
  transcripts: ScreeningTranscriptLinkRow[];
}

export interface PublicationAttemptResult {
  publication_id: string;
  state: string;
  skipped: boolean;
}

@Injectable()
export class TechnicalScreeningService {
  constructor(
    private readonly repo: TechnicalScreeningRepository,
    @Inject(SCREENING_EVIDENCE_PUBLISHER) private readonly publisher: ScreeningEvidencePublisher,
  ) {}

  // ---- reads ----------------------------------------------------------

  async listForTalent(tenantId: string, talentRecordId: string): Promise<ScreeningSessionRow[]> {
    return this.repo.listSessionsForTalent(tenantId, talentRecordId);
  }

  // Tenant-bound; another tenant's id is indistinguishable from an absent one.
  async findSession(tenantId: string, sessionId: string): Promise<ScreeningSessionRow | null> {
    return this.repo.findSession(tenantId, sessionId);
  }

  async getDetail(tenantId: string, sessionId: string, requestId: string): Promise<ScreeningSessionDetail> {
    const session = await this.repo.findSession(tenantId, sessionId);
    if (session === null) throw notFound(requestId);
    const [findings, publications, citations, questions, notes, suggestions, generations, transcripts] =
      await Promise.all([
        this.repo.listFindings(tenantId, sessionId),
        this.repo.listPublications(tenantId, sessionId),
        this.repo.listCitations(tenantId, sessionId),
        this.repo.listQuestions(tenantId, sessionId),
        this.repo.listNotes(tenantId, sessionId),
        this.repo.listSuggestions(tenantId, sessionId),
        this.repo.listGenerations(tenantId, sessionId),
        this.repo.listTranscriptLinks(tenantId, sessionId),
      ]);
    return { session, findings, publications, citations, questions, notes, suggestions, generations, transcripts };
  }

  async listEvents(tenantId: string, sessionId: string): Promise<ScreeningEventRow[]> {
    return this.repo.listEvents(tenantId, sessionId);
  }

  // ---- DRAFT lifecycle -------------------------------------------------

  async createSession(input: {
    tenant_id: string;
    site_id: string | null;
    talent_record_id: string;
    interaction_id: string | null;
    requisition_id?: string | null;
    actor_id: string;
  }): Promise<ScreeningSessionRow> {
    return this.repo.createSession(input);
  }

  // ---- INC-3 A1 — question plan, notes, suggestions, AI-draft review -------

  async addQuestion(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    text: unknown;
    skill_ref?: unknown;
    requestId: string;
  }): Promise<ScreeningQuestionRow> {
    const text = boundedText(input.text, SCREENING_QUESTION_MAX);
    if (text === null) throw validation(input.requestId, `text must be 1..${SCREENING_QUESTION_MAX} characters`);
    const skill = input.skill_ref === undefined || input.skill_ref === null ? null : boundedText(input.skill_ref, SCREENING_SKILL_MAX);
    return this.guarded(input.requestId, () =>
      this.repo.addQuestion({ tenant_id: input.tenant_id, session_id: input.session_id, actor_id: input.actor_id, text, skill_ref: skill }),
    );
  }

  async updateQuestion(input: {
    tenant_id: string;
    session_id: string;
    question_id: string;
    actor_id: string;
    text?: unknown;
    status?: unknown;
    requestId: string;
  }): Promise<ScreeningQuestionRow> {
    let text: string | undefined;
    if (input.text !== undefined) {
      const t = boundedText(input.text, SCREENING_QUESTION_MAX);
      if (t === null) throw validation(input.requestId, `text must be 1..${SCREENING_QUESTION_MAX} characters`);
      text = t;
    }
    let status: string | undefined;
    if (input.status !== undefined) {
      if (typeof input.status !== 'string' || !(QUESTION_STATUSES as readonly string[]).includes(input.status)) {
        throw validation(input.requestId, `status must be one of ${QUESTION_STATUSES.join('|')}`);
      }
      status = input.status;
    }
    if (text === undefined && status === undefined) throw validation(input.requestId, 'nothing to update');
    return this.guarded(input.requestId, () =>
      this.repo.updateQuestion({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        question_id: input.question_id,
        actor_id: input.actor_id,
        ...(text !== undefined ? { text } : {}),
        ...(status !== undefined ? { status } : {}),
      }),
    );
  }

  async addNote(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    body: unknown;
    requestId: string;
  }): Promise<ScreeningNoteRow> {
    const body = boundedText(input.body, SCREENING_NOTE_MAX);
    if (body === null) throw validation(input.requestId, `body must be 1..${SCREENING_NOTE_MAX} characters`);
    return this.guarded(input.requestId, () =>
      this.repo.addNote({ tenant_id: input.tenant_id, session_id: input.session_id, actor_id: input.actor_id, body }),
    );
  }

  async actionSuggestion(input: {
    tenant_id: string;
    session_id: string;
    suggestion_id: string;
    actor_id: string;
    action: unknown;
    requestId: string;
  }): Promise<ScreeningSuggestionRow> {
    if (typeof input.action !== 'string' || !(SUGGESTION_ACTIONS as readonly string[]).includes(input.action)) {
      throw validation(input.requestId, `action must be one of ${SUGGESTION_ACTIONS.join('|')}`);
    }
    const action = input.action as 'USED' | 'DISMISSED';
    return this.guarded(input.requestId, () =>
      this.repo.actionSuggestion({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        suggestion_id: input.suggestion_id,
        actor_id: input.actor_id,
        action,
      }),
    );
  }

  // §B.2 — accept an AI draft as drafted (CONFIRMED) or reject it. Editing an
  // AI draft goes through editFinding and records EDITED.
  async reviewAiFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    version: unknown;
    outcome: unknown;
    actor_id: string;
    requestId: string;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    const version = requireVersion(input.version, input.requestId);
    if (input.outcome !== 'CONFIRMED' && input.outcome !== 'REJECTED') {
      throw validation(input.requestId, 'outcome must be CONFIRMED or REJECTED');
    }
    const outcome = input.outcome;
    return this.guarded(input.requestId, () =>
      this.repo.reviewAiFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        finding_id: input.finding_id,
        expected_version: version,
        actor_id: input.actor_id,
        outcome,
      }),
    );
  }

  async linkMeeting(input: {
    tenant_id: string;
    session_id: string;
    interaction_id: string;
    actor_id: string;
    requestId: string;
  }): Promise<ScreeningSessionRow> {
    return this.guarded(input.requestId, () => this.repo.linkMeeting(input));
  }

  async recordMeetingPreparation(input: {
    tenant_id: string;
    session_id: string;
    recording_requested: boolean;
    requestId: string;
  }): Promise<void> {
    return this.guarded(input.requestId, () =>
      this.repo.recordMeetingPreparation(input.tenant_id, input.session_id, input.recording_requested),
    );
  }

  async linkTranscript(input: {
    tenant_id: string;
    session_id: string;
    conversation_transcript_id: string;
    source: 'TEAMS_GRAPH' | 'EXTERNAL_PROVIDER';
    actor_id: string;
    requestId: string;
  }): Promise<{ linked: boolean }> {
    return this.guarded(input.requestId, () => this.repo.linkTranscript(input));
  }

  async addFinding(input: {
    tenant_id: string;
    session_id: string;
    version: unknown;
    actor_id: string;
    finding: ScreeningFindingInput;
    requestId: string;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    const version = requireVersion(input.version, input.requestId);
    const fields = validateFinding(input.finding, input.requestId);
    return this.guarded(input.requestId, () =>
      this.repo.addFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        expected_version: version,
        actor_id: input.actor_id,
        fields,
      }),
    );
  }

  async editFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    version: unknown;
    actor_id: string;
    finding: ScreeningFindingInput;
    requestId: string;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    const version = requireVersion(input.version, input.requestId);
    const fields = validateFinding(input.finding, input.requestId);
    return this.guarded(input.requestId, () =>
      this.repo.editFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        finding_id: input.finding_id,
        expected_version: version,
        actor_id: input.actor_id,
        fields,
      }),
    );
  }

  async removeFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    version: unknown;
    actor_id: string;
    requestId: string;
  }): Promise<{ version: number }> {
    const version = requireVersion(input.version, input.requestId);
    return this.guarded(input.requestId, () =>
      this.repo.removeFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        finding_id: input.finding_id,
        expected_version: version,
        actor_id: input.actor_id,
      }),
    );
  }

  async voidSession(input: {
    tenant_id: string;
    session_id: string;
    version: unknown;
    reason: unknown;
    actor_id: string;
    requestId: string;
  }): Promise<ScreeningSessionRow> {
    const version = requireVersion(input.version, input.requestId);
    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (typeof input.reason !== 'string' || input.reason.trim().length > SCREENING_VOID_REASON_MAX) {
        throw validation(input.requestId, `reason must be a string of at most ${SCREENING_VOID_REASON_MAX} characters`);
      }
      reason = input.reason.trim().length > 0 ? input.reason.trim() : null;
    }
    return this.guarded(input.requestId, () =>
      this.repo.voidSession({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        expected_version: version,
        actor_id: input.actor_id,
        reason,
        now: new Date(),
      }),
    );
  }

  // Directive §6 — explicit recruiter confirmation. Refusal order: version shape
  // / empty set (400) → attestation (422) → lifecycle + CAS + set match (repo).
  async confirm(input: {
    tenant_id: string;
    session_id: string;
    version: unknown;
    confirmed_finding_ids: unknown;
    observations_confirmed: unknown;
    actor_id: string;
    requestId: string;
  }): Promise<{ session: ScreeningSessionRow; publications: ScreeningPublicationRow[] }> {
    const version = requireVersion(input.version, input.requestId);
    const ids = input.confirmed_finding_ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string' && i.length > 0)) {
      throw validation(input.requestId, 'confirmed_finding_ids must be a non-empty array of finding ids');
    }
    if (input.observations_confirmed !== true) {
      throw new AramoError(
        'ATTESTATION_MISSING',
        'the recruiter must confirm the recorded observations',
        422,
        { requestId: input.requestId },
      );
    }
    return this.guarded(input.requestId, () =>
      this.repo.confirmSession({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        expected_version: version,
        confirmed_finding_ids: ids as string[],
        actor_id: input.actor_id,
        now: new Date(),
      }),
    );
  }

  // ---- publication (directive §7) -------------------------------------

  // Attempt every PENDING intent of a CONFIRMED session. Never re-reads the
  // mutable session/finding for the trust call; never rolls back a confirmation.
  async publishPending(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    requestId: string;
  }): Promise<PublicationAttemptResult[]> {
    const session = await this.repo.findSession(input.tenant_id, input.session_id);
    if (session === null) throw notFound(input.requestId);
    if (session.state !== 'CONFIRMED') {
      throw new AramoError(
        'SCREENING_SESSION_STATE_INVALID',
        'only a CONFIRMED screening session can be published',
        422,
        { requestId: input.requestId },
      );
    }
    const ids = await this.repo.listPendingPublicationIds(input.tenant_id, input.session_id);
    const results: PublicationAttemptResult[] = [];
    for (const publicationId of ids) {
      results.push(
        await this.repo.runPublicationAttempt({
          tenant_id: input.tenant_id,
          publication_id: publicationId,
          actor_id: input.actor_id,
          now: () => new Date(),
          attempt: async (intent) => {
            try {
              const res = await this.publisher.publish({
                tenant_id: intent.tenant_id,
                talent_record_id: intent.talent_record_id_at_confirm,
                evidence_id: intent.evidence_record_id,
                assertion_payload: intent.canonical_payload as Record<string, unknown>,
                collected_at: intent.collected_at,
              });
              return { outcome: 'published', written: res.written };
            } catch (err) {
              if (errorCode(err) === 'IDEMPOTENCY_KEY_CONFLICT') return { outcome: 'conflict' };
              return { outcome: 'failed', error_code: errorCode(err) ?? 'PUBLICATION_FAILED' };
            }
          },
        }),
      );
    }
    return results;
  }

  // ---- internals ------------------------------------------------------

  private async guarded<T>(requestId: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof ScreeningGuardError)) throw err;
      switch (err.reason) {
        case 'not_found':
        case 'finding_not_found':
          throw notFound(requestId);
        case 'state_invalid':
          throw new AramoError(
            'SCREENING_SESSION_STATE_INVALID',
            'the screening session is no longer a draft',
            422,
            { requestId },
          );
        case 'question_not_found':
        case 'suggestion_not_found':
          throw notFound(requestId);
        case 'ai_finding_not_removable':
          throw new AramoError(
            'SCREENING_SESSION_STATE_INVALID',
            'an AI-drafted finding is reviewed (accepted, edited or rejected), never removed',
            422,
            { requestId },
          );
        case 'not_ai_finding':
          throw validation(requestId, 'only an AI-drafted finding has a review outcome');
        case 'unreviewed_ai_findings':
          throw validation(requestId, 'every AI-drafted finding must be reviewed before confirmation');
        case 'suggestion_already_actioned':
          throw new AramoError(
            'SCREENING_SESSION_VERSION_CONFLICT',
            'this suggestion already has a recruiter action',
            409,
            { requestId },
          );
        case 'meeting_already_linked':
          throw new AramoError(
            'SCREENING_SESSION_STATE_INVALID',
            'a meeting is already linked to this screening session',
            422,
            { requestId, details: { reason: 'meeting_already_linked' } },
          );
        case 'question_limit':
          throw validation(requestId, 'the question plan is full');
        case 'version_conflict':
        case 'finding_set_mismatch':
          throw new AramoError(
            'SCREENING_SESSION_VERSION_CONFLICT',
            'the screening session changed; reload and retry',
            409,
            { requestId },
          );
      }
    }
  }
}

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'not found', 404, { requestId });
}

function validation(requestId: string, message: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

function requireVersion(v: unknown, requestId: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw validation(requestId, 'version must be a positive integer');
  }
  return v;
}

function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

function validateFinding(f: ScreeningFindingInput, requestId: string): ScreeningFindingFields {
  const errors: string[] = [];
  const skill = boundedText(f.skill_raw, SCREENING_SKILL_MAX);
  if (skill === null) errors.push(`skill_raw must be 1..${SCREENING_SKILL_MAX} characters`);
  const basisOk = typeof f.basis === 'string' && (SCREENING_BASES as readonly string[]).includes(f.basis);
  if (!basisOk) errors.push(`basis must be one of ${SCREENING_BASES.join('|')}`);
  const observation = boundedText(f.observation_raw, SCREENING_TEXT_MAX);
  if (observation === null) errors.push(`observation_raw must be 1..${SCREENING_TEXT_MAX} characters`);
  let demonstration: string | null = null;
  if (f.basis === 'DEMONSTRATED') {
    demonstration = boundedText(f.demonstration_raw, SCREENING_TEXT_MAX);
    if (demonstration === null) errors.push('demonstration_raw is required when basis is DEMONSTRATED');
  } else if (f.demonstration_raw !== undefined && f.demonstration_raw !== null && f.demonstration_raw !== '') {
    errors.push('demonstration_raw is only permitted when basis is DEMONSTRATED');
  }
  let limitations: string | null = null;
  if (f.limitations_raw !== undefined && f.limitations_raw !== null && f.limitations_raw !== '') {
    if (typeof f.limitations_raw !== 'string' || f.limitations_raw.trim().length > SCREENING_TEXT_MAX) {
      errors.push(`limitations_raw must be at most ${SCREENING_TEXT_MAX} characters`);
    } else {
      limitations = f.limitations_raw.trim().length > 0 ? f.limitations_raw.trim() : null;
    }
  }
  if (errors.length > 0) {
    throw new AramoError('VALIDATION_ERROR', errors.join('; '), 400, {
      requestId,
      details: { errors },
    });
  }
  return {
    skill_raw: skill as string,
    basis: f.basis as string,
    observation_raw: observation as string,
    demonstration_raw: demonstration,
    limitations_raw: limitations,
  };
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return null;
}
