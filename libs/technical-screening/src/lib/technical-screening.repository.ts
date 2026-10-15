import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import { buildScreeningFindingPayload, screeningPayloadHash } from './screening-payload.js';
import { SCREENING_QUESTIONS_PER_SESSION_MAX, type ScreeningEventType } from './screening-vocab.js';

// TIP-E2E INC-3 — the technical_screening persistence surface
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §4–§7, §10.3).
//
// Every read is tenant-bound (another tenant's id ≡ an absent one). Every DRAFT
// mutation carries the session version IN THE WRITE PREDICATE (a guarded
// updateMany + affected-row check — never a read-then-write CAS), and its
// content-free ScreeningEvent is appended in the SAME transaction. Confirmation
// writes the CONFIRMED transition, one pinned PENDING publication intent per
// finding and SESSION_CONFIRMED atomically. Publication attempts serialize on the
// intent row (SELECT … FOR UPDATE) and rebuild the trust call ONLY from the
// pinned intent. No delete path exists here except DRAFT finding removal
// (directive §10.1 — confinement-spec enforced).

export interface ScreeningSessionRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  talent_record_id: string;
  interaction_id: string | null;
  requisition_id: string | null;
  state: string;
  version: number;
  created_by_actor_id: string;
  created_at: Date;
  updated_at: Date;
  confirmed_by_actor_id: string | null;
  confirmed_at: Date | null;
  confirmed_version: number | null;
  confirmation_attested: boolean | null;
  voided_by_actor_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
}

export interface ScreeningFindingRow {
  id: string;
  tenant_id: string;
  session_id: string;
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
  origin: string;
  review_status: string | null;
  evidence_source: string;
  ai_original: unknown | null;
  generation_id: string | null;
  reviewed_by_actor_id: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScreeningCitationRow {
  id: string;
  tenant_id: string;
  finding_id: string;
  conversation_transcript_id: string;
  utterance_id: string;
  start_offset: number;
  end_offset: number;
  normalized_sha256: string;
  created_at: Date;
}

export interface ScreeningQuestionRow {
  id: string;
  tenant_id: string;
  session_id: string;
  text: string;
  skill_ref: string | null;
  intent: string;
  origin: string;
  status: string;
  edited: boolean;
  position: number;
  generation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScreeningNoteRow {
  id: string;
  tenant_id: string;
  session_id: string;
  body: string;
  actor_id: string;
  created_at: Date;
}

export interface ScreeningSuggestionRow {
  id: string;
  tenant_id: string;
  session_id: string;
  generation_id: string;
  text: string;
  trigger_kind: string;
  trigger_ref: unknown;
  action: string | null;
  actioned_by_actor_id: string | null;
  actioned_at: Date | null;
  created_at: Date;
}

export interface ScreeningGenerationRow {
  id: string;
  tenant_id: string;
  session_id: string;
  kind: string;
  provider: string;
  model: string;
  provider_request_id: string | null;
  prompt_version: string;
  input_sha256: string;
  used_talent_profile: boolean;
  used_requisition: boolean;
  used_transcript: boolean;
  output_count: number;
  actor_id: string;
  created_at: Date;
}

export interface ScreeningTranscriptLinkRow {
  id: string;
  tenant_id: string;
  session_id: string;
  conversation_transcript_id: string;
  source: string;
  created_at: Date;
}

// INC-3 A1 — the provenance of one model call (provider and model ACTUALLY used).
export interface AiGenerationInput {
  kind: string;
  provider: string;
  model: string;
  provider_request_id: string | null;
  prompt_version: string;
  input_sha256: string;
  used_talent_profile: boolean;
  used_requisition: boolean;
  used_transcript: boolean;
}

export interface AiDraftedFindingInput {
  skill_raw: string;
  basis: string;
  observation_raw: string;
  limitations_raw: string | null;
  evidence_source: string;
  citations: Array<{
    conversation_transcript_id: string;
    utterance_id: string;
    start_offset: number;
    end_offset: number;
    normalized_sha256: string;
  }>;
}

export interface ScreeningPublicationRow {
  id: string;
  tenant_id: string;
  session_id: string;
  finding_id: string;
  evidence_record_id: string;
  talent_record_id_at_confirm: string;
  canonical_payload: unknown;
  payload_hash: string;
  collected_at: Date;
  state: string;
  attempt_count: number;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  published_at: Date | null;
  created_at: Date;
}

export interface ScreeningEventRow {
  id: string;
  tenant_id: string;
  session_id: string;
  event_type: string;
  actor_id: string;
  session_version: number;
  payload: unknown;
  occurred_at: Date;
}

export interface ScreeningFindingFields {
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
}

// Why a DRAFT-guarded write matched no row. Classified AFTER the guarded write
// fails, so the refusal order is: absent (404) → not DRAFT (422) → stale (409).
export type DraftGuardFailure = 'not_found' | 'state_invalid' | 'version_conflict';

export type ScreeningGuardReason =
  | DraftGuardFailure
  | 'finding_not_found'
  | 'finding_set_mismatch'
  // INC-3 A1 §B.2 — an AI draft must be reviewed (accepted / edited / rejected),
  // never deleted, and unreviewed drafts block confirmation.
  | 'ai_finding_not_removable'
  | 'unreviewed_ai_findings'
  | 'not_ai_finding'
  | 'question_not_found'
  | 'suggestion_not_found'
  | 'suggestion_already_actioned'
  | 'question_limit'
  // INC-3 A1-4 — a session links at most one meeting (re-linking is refused).
  | 'meeting_already_linked';

export class ScreeningGuardError extends Error {
  constructor(readonly reason: ScreeningGuardReason) {
    super(reason);
    this.name = 'ScreeningGuardError';
  }
}

type ScreeningTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

// The interactive-transaction window for one publication attempt: it spans the
// synchronous Talent Trust write (its own transaction on its own connection).
const PUBLICATION_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

@Injectable()
export class TechnicalScreeningRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- reads (tenant-bound) -------------------------------------------

  async findSession(tenantId: string, sessionId: string): Promise<ScreeningSessionRow | null> {
    return (await this.prisma.screeningSession.findFirst({
      where: { id: sessionId, tenant_id: tenantId },
    })) as ScreeningSessionRow | null;
  }

  async listSessionsForTalent(tenantId: string, talentRecordId: string): Promise<ScreeningSessionRow[]> {
    return (await this.prisma.screeningSession.findMany({
      where: { tenant_id: tenantId, talent_record_id: talentRecordId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    })) as ScreeningSessionRow[];
  }

  async listFindings(tenantId: string, sessionId: string): Promise<ScreeningFindingRow[]> {
    return (await this.prisma.screeningFinding.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningFindingRow[];
  }

  async listPublications(tenantId: string, sessionId: string): Promise<ScreeningPublicationRow[]> {
    return (await this.prisma.screeningEvidencePublication.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningPublicationRow[];
  }

  async listEvents(tenantId: string, sessionId: string): Promise<ScreeningEventRow[]> {
    return (await this.prisma.screeningEvent.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningEventRow[];
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
    return this.prisma.$transaction(async (tx) => {
      const session = (await tx.screeningSession.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          site_id: input.site_id,
          talent_record_id: input.talent_record_id,
          interaction_id: input.interaction_id,
          requisition_id: input.requisition_id ?? null,
          state: 'DRAFT',
          version: 1,
          created_by_actor_id: input.actor_id,
        },
      })) as ScreeningSessionRow;
      await this.appendEvent(tx, session, 'SESSION_CREATED', input.actor_id, session.version, {
        has_requisition: (input.requisition_id ?? null) !== null,
      });
      return session;
    });
  }

  async addFinding(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    actor_id: string;
    fields: ScreeningFindingFields;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const finding = (await tx.screeningFinding.create({
        data: { id: uuidv7(), tenant_id: input.tenant_id, session_id: input.session_id, ...input.fields },
      })) as ScreeningFindingRow;
      await this.appendEvent(tx, session, 'FINDING_ADDED', input.actor_id, session.version, {
        finding_id: finding.id,
        basis: finding.basis,
      });
      return { finding, version: session.version };
    });
  }

  async editFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    expected_version: number;
    actor_id: string;
    fields: ScreeningFindingFields;
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const current = await tx.screeningFinding.findFirst({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        select: { origin: true },
      });
      if (current === null) throw new ScreeningGuardError('finding_not_found');
      const now = new Date();
      // INC-3 A1 §B.2 — editing an AI draft records the recruiter's review
      // (EDITED); origin and the retained AI original never change.
      const reviewData =
        current.origin === 'AI_DRAFTED'
          ? { review_status: 'EDITED', reviewed_by_actor_id: input.actor_id, reviewed_at: now }
          : {};
      const updated = await tx.screeningFinding.updateMany({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        data: { ...input.fields, ...reviewData, updated_at: now },
      });
      if (updated.count !== 1) throw new ScreeningGuardError('finding_not_found');
      const finding = (await tx.screeningFinding.findFirstOrThrow({
        where: { id: input.finding_id, tenant_id: input.tenant_id },
      })) as ScreeningFindingRow;
      await this.appendEvent(tx, session, 'FINDING_EDITED', input.actor_id, session.version, {
        finding_id: finding.id,
        basis: finding.basis,
      });
      return { finding, version: session.version };
    });
  }

  // The one application delete path on screening tables (directive §10.1): a
  // finding of a DRAFT session, inside the same version-guarded transaction.
  async removeFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    expected_version: number;
    actor_id: string;
  }): Promise<{ version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const current = await tx.screeningFinding.findFirst({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        select: { origin: true },
      });
      if (current === null) throw new ScreeningGuardError('finding_not_found');
      // INC-3 A1 §B.2 — an AI draft is rejected (kept with its provenance), never deleted.
      if (current.origin === 'AI_DRAFTED') throw new ScreeningGuardError('ai_finding_not_removable');
      const removed = await tx.screeningFinding.deleteMany({
        where: {
          id: input.finding_id,
          session_id: input.session_id,
          tenant_id: input.tenant_id,
          origin: 'RECRUITER_AUTHORED',
        },
      });
      if (removed.count !== 1) throw new ScreeningGuardError('finding_not_found');
      await this.appendEvent(tx, session, 'FINDING_REMOVED', input.actor_id, session.version, {
        finding_id: input.finding_id,
      });
      return { version: session.version };
    });
  }

  async voidSession(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    actor_id: string;
    reason: string | null;
    now: Date;
  }): Promise<ScreeningSessionRow> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.screeningSession.updateMany({
        where: {
          id: input.session_id,
          tenant_id: input.tenant_id,
          state: 'DRAFT',
          version: input.expected_version,
        },
        data: {
          state: 'VOIDED',
          version: input.expected_version + 1,
          voided_by_actor_id: input.actor_id,
          voided_at: input.now,
          void_reason: input.reason,
          updated_at: input.now,
        },
      });
      if (res.count !== 1) await this.throwGuardFailure(tx, input.tenant_id, input.session_id);
      const session = await this.loadSession(tx, input.tenant_id, input.session_id);
      await this.appendEvent(tx, session, 'SESSION_VOIDED', input.actor_id, session.version, {
        has_reason: input.reason !== null,
      });
      return session;
    });
  }

  // Directive §6 — ONE screening transaction: CAS to CONFIRMED (actor, server
  // time, version, attestation), one PENDING intent per finding with every
  // publication input pinned, SESSION_CONFIRMED. Any failure → nothing commits.
  async confirmSession(input: {
    tenant_id: string;
    session_id: string;
    expected_version: number;
    confirmed_finding_ids: readonly string[];
    actor_id: string;
    now: Date;
  }): Promise<{ session: ScreeningSessionRow; publications: ScreeningPublicationRow[] }> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.screeningSession.updateMany({
        where: {
          id: input.session_id,
          tenant_id: input.tenant_id,
          state: 'DRAFT',
          version: input.expected_version,
        },
        data: {
          state: 'CONFIRMED',
          version: input.expected_version + 1,
          confirmed_by_actor_id: input.actor_id,
          confirmed_at: input.now,
          confirmed_version: input.expected_version,
          confirmation_attested: true,
          updated_at: input.now,
        },
      });
      if (res.count !== 1) await this.throwGuardFailure(tx, input.tenant_id, input.session_id);
      const session = await this.loadSession(tx, input.tenant_id, input.session_id);
      const allFindings = (await tx.screeningFinding.findMany({
        where: { tenant_id: input.tenant_id, session_id: input.session_id },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })) as ScreeningFindingRow[];
      // INC-3 A1 §B.2 — every AI draft must be reviewed first; REJECTED drafts
      // are kept with their provenance but are never published.
      if (allFindings.some((f) => f.origin === 'AI_DRAFTED' && f.review_status === 'DRAFT')) {
        throw new ScreeningGuardError('unreviewed_ai_findings');
      }
      const findings = allFindings.filter((f) => f.review_status !== 'REJECTED');
      const citationRows = (await tx.screeningFindingCitation.findMany({
        where: { tenant_id: input.tenant_id, finding_id: { in: findings.map((f) => f.id) } },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })) as ScreeningCitationRow[];
      const stored = [...findings.map((f) => f.id)].sort();
      const requested = [...new Set(input.confirmed_finding_ids)].sort();
      if (
        stored.length === 0 ||
        stored.length !== requested.length ||
        stored.some((id, i) => id !== requested[i])
      ) {
        throw new ScreeningGuardError('finding_set_mismatch');
      }
      const intents = findings.map((finding) => {
        const payload = buildScreeningFindingPayload({
          session_id: session.id,
          finding,
          citations: citationRows.filter((c) => c.finding_id === finding.id),
          confirmed_at: input.now,
          confirmed_version: input.expected_version,
        });
        return {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          session_id: session.id,
          finding_id: finding.id,
          evidence_record_id: uuidv7(),
          talent_record_id_at_confirm: session.talent_record_id,
          canonical_payload: payload as object,
          payload_hash: screeningPayloadHash(payload),
          collected_at: input.now,
          state: 'PENDING',
        };
      });
      await tx.screeningEvidencePublication.createMany({ data: intents });
      await this.appendEvent(tx, session, 'SESSION_CONFIRMED', input.actor_id, session.version, {
        finding_count: findings.length,
        confirmed_version: input.expected_version,
      });
      const publications = (await tx.screeningEvidencePublication.findMany({
        where: { tenant_id: input.tenant_id, session_id: session.id },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })) as ScreeningPublicationRow[];
      return { session, publications };
    });
  }

  // ---- INC-3 A1 — question plan, notes, assistance, meeting/transcript links

  async listQuestions(tenantId: string, sessionId: string): Promise<ScreeningQuestionRow[]> {
    return (await this.prisma.screeningQuestion.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningQuestionRow[];
  }

  async listNotes(tenantId: string, sessionId: string): Promise<ScreeningNoteRow[]> {
    return (await this.prisma.screeningNote.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningNoteRow[];
  }

  async listSuggestions(tenantId: string, sessionId: string): Promise<ScreeningSuggestionRow[]> {
    return (await this.prisma.screeningAssistSuggestion.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningSuggestionRow[];
  }

  async listGenerations(tenantId: string, sessionId: string): Promise<ScreeningGenerationRow[]> {
    return (await this.prisma.screeningAiGeneration.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningGenerationRow[];
  }

  async listCitations(tenantId: string, sessionId: string): Promise<ScreeningCitationRow[]> {
    const findingIds = (
      await this.prisma.screeningFinding.findMany({
        where: { tenant_id: tenantId, session_id: sessionId },
        select: { id: true },
      })
    ).map((f) => f.id);
    if (findingIds.length === 0) return [];
    return (await this.prisma.screeningFindingCitation.findMany({
      where: { tenant_id: tenantId, finding_id: { in: findingIds } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningCitationRow[];
  }

  async listTranscriptLinks(tenantId: string, sessionId: string): Promise<ScreeningTranscriptLinkRow[]> {
    return (await this.prisma.screeningTranscriptLink.findMany({
      where: { tenant_id: tenantId, session_id: sessionId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as ScreeningTranscriptLinkRow[];
  }

  // Sessions linked to a Communications interaction (exactly-one resolution is
  // the caller's job; this returns every tenant-bound match).
  async findSessionsByInteraction(tenantId: string, interactionId: string): Promise<ScreeningSessionRow[]> {
    return (await this.prisma.screeningSession.findMany({
      where: { tenant_id: tenantId, interaction_id: interactionId },
    })) as ScreeningSessionRow[];
  }

  // §B.3 — persist an AI question plan: the generation ledger row plus the new
  // PROPOSED questions. Regeneration retires earlier still-PROPOSED AI questions
  // (SELECTED and recruiter-authored questions are kept). DRAFT only.
  async saveQuestionPlan(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    generation: AiGenerationInput;
    questions: Array<{ text: string; skill_ref: string | null; intent: string }>;
  }): Promise<{ generation_id: string; questions: ScreeningQuestionRow[] }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      await tx.screeningQuestion.updateMany({
        where: { tenant_id: input.tenant_id, session_id: input.session_id, origin: 'AI_GENERATED', status: 'PROPOSED' },
        data: { status: 'REMOVED', updated_at: new Date() },
      });
      const live = await tx.screeningQuestion.count({
        where: { tenant_id: input.tenant_id, session_id: input.session_id, status: { not: 'REMOVED' } },
      });
      const generationId = await this.insertGeneration(tx, session, input.actor_id, input.generation, input.questions.length);
      const max = await tx.screeningQuestion.aggregate({
        where: { tenant_id: input.tenant_id, session_id: input.session_id },
        _max: { position: true },
      });
      let position = (max._max.position ?? 0) + 1;
      const room = Math.max(0, SCREENING_QUESTIONS_PER_SESSION_MAX - live);
      for (const q of input.questions.slice(0, room)) {
        await tx.screeningQuestion.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            session_id: input.session_id,
            text: q.text,
            skill_ref: q.skill_ref,
            intent: q.intent,
            origin: 'AI_GENERATED',
            status: 'PROPOSED',
            position: position++,
            generation_id: generationId,
          },
        });
      }
      await this.appendEvent(tx, session, 'QUESTION_PLAN_GENERATED', input.actor_id, session.version, {
        generation_id: generationId,
        question_count: Math.min(input.questions.length, room),
      });
      const questions = (await tx.screeningQuestion.findMany({
        where: { tenant_id: input.tenant_id, session_id: input.session_id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      })) as ScreeningQuestionRow[];
      return { generation_id: generationId, questions };
    });
  }

  async addQuestion(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    text: string;
    skill_ref: string | null;
  }): Promise<ScreeningQuestionRow> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const live = await tx.screeningQuestion.count({
        where: { tenant_id: input.tenant_id, session_id: input.session_id, status: { not: 'REMOVED' } },
      });
      if (live >= SCREENING_QUESTIONS_PER_SESSION_MAX) throw new ScreeningGuardError('question_limit');
      const max = await tx.screeningQuestion.aggregate({
        where: { tenant_id: input.tenant_id, session_id: input.session_id },
        _max: { position: true },
      });
      const question = (await tx.screeningQuestion.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          text: input.text,
          skill_ref: input.skill_ref,
          intent: 'PROBE',
          origin: 'RECRUITER_AUTHORED',
          status: 'SELECTED',
          position: (max._max.position ?? 0) + 1,
        },
      })) as ScreeningQuestionRow;
      await this.appendEvent(tx, session, 'QUESTION_EDITED', input.actor_id, session.version, {
        question_id: question.id,
        change: 'added',
      });
      return question;
    });
  }

  // Edit text and/or change status (select, deselect to PROPOSED, remove).
  async updateQuestion(input: {
    tenant_id: string;
    session_id: string;
    question_id: string;
    actor_id: string;
    text?: string;
    status?: string;
  }): Promise<ScreeningQuestionRow> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const current = await tx.screeningQuestion.findFirst({
        where: { id: input.question_id, session_id: input.session_id, tenant_id: input.tenant_id },
      });
      if (current === null) throw new ScreeningGuardError('question_not_found');
      const data: Record<string, unknown> = { updated_at: new Date() };
      if (input.text !== undefined && input.text !== current.text) {
        data['text'] = input.text;
        data['edited'] = true;
      }
      if (input.status !== undefined) data['status'] = input.status;
      await tx.screeningQuestion.updateMany({
        where: { id: input.question_id, session_id: input.session_id, tenant_id: input.tenant_id },
        data,
      });
      if (data['text'] !== undefined) {
        await this.appendEvent(tx, session, 'QUESTION_EDITED', input.actor_id, session.version, {
          question_id: input.question_id,
          change: 'text',
        });
      }
      if (input.status !== undefined && input.status !== current.status) {
        await this.appendEvent(tx, session, 'QUESTION_SELECTION_CHANGED', input.actor_id, session.version, {
          question_id: input.question_id,
          status: input.status,
        });
      }
      return (await tx.screeningQuestion.findFirstOrThrow({
        where: { id: input.question_id, tenant_id: input.tenant_id },
      })) as ScreeningQuestionRow;
    });
  }

  async addNote(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    body: string;
  }): Promise<ScreeningNoteRow> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const note = (await tx.screeningNote.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          body: input.body,
          actor_id: input.actor_id,
        },
      })) as ScreeningNoteRow;
      await this.appendEvent(tx, session, 'NOTE_ADDED', input.actor_id, session.version, { note_id: note.id });
      return note;
    });
  }

  // §B.4 — advisory suggestions with their generation provenance. DRAFT only.
  async saveSuggestions(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    generation: AiGenerationInput;
    trigger_kind: 'NOTE' | 'TRANSCRIPT_SEGMENTS';
    trigger_ref: Record<string, unknown>;
    suggestions: string[];
  }): Promise<ScreeningSuggestionRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const generationId = await this.insertGeneration(tx, session, input.actor_id, input.generation, input.suggestions.length);
      const rows: ScreeningSuggestionRow[] = [];
      for (const text of input.suggestions) {
        rows.push((await tx.screeningAssistSuggestion.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            session_id: input.session_id,
            generation_id: generationId,
            text,
            trigger_kind: input.trigger_kind,
            trigger_ref: input.trigger_ref as object,
          },
        })) as ScreeningSuggestionRow);
      }
      await this.appendEvent(tx, session, 'SUGGESTION_GENERATED', input.actor_id, session.version, {
        generation_id: generationId,
        suggestion_count: rows.length,
        trigger_kind: input.trigger_kind,
      });
      return rows;
    });
  }

  async actionSuggestion(input: {
    tenant_id: string;
    session_id: string;
    suggestion_id: string;
    actor_id: string;
    action: 'USED' | 'DISMISSED';
  }): Promise<ScreeningSuggestionRow> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const res = await tx.screeningAssistSuggestion.updateMany({
        where: { id: input.suggestion_id, session_id: input.session_id, tenant_id: input.tenant_id, action: null },
        data: { action: input.action, actioned_by_actor_id: input.actor_id, actioned_at: new Date() },
      });
      if (res.count !== 1) {
        const exists = await tx.screeningAssistSuggestion.findFirst({
          where: { id: input.suggestion_id, session_id: input.session_id, tenant_id: input.tenant_id },
          select: { id: true },
        });
        throw new ScreeningGuardError(exists === null ? 'suggestion_not_found' : 'suggestion_already_actioned');
      }
      await this.appendEvent(tx, session, 'SUGGESTION_ACTIONED', input.actor_id, session.version, {
        suggestion_id: input.suggestion_id,
        action: input.action,
      });
      return (await tx.screeningAssistSuggestion.findFirstOrThrow({
        where: { id: input.suggestion_id, tenant_id: input.tenant_id },
      })) as ScreeningSuggestionRow;
    });
  }

  // Link the scheduled Communications meeting interaction (A1-4). DRAFT only.
  async linkMeeting(input: {
    tenant_id: string;
    session_id: string;
    interaction_id: string;
    actor_id: string;
  }): Promise<ScreeningSessionRow> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockDraft(tx, input.tenant_id, input.session_id);
      if (locked.interaction_id === input.interaction_id) return locked;
      if (locked.interaction_id !== null) throw new ScreeningGuardError('meeting_already_linked');
      await tx.screeningSession.updateMany({
        where: { id: input.session_id, tenant_id: input.tenant_id, state: 'DRAFT' },
        data: { interaction_id: input.interaction_id, updated_at: new Date() },
      });
      const session = await this.loadSession(tx, input.tenant_id, input.session_id);
      await this.appendEvent(tx, session, 'MEETING_LINKED', input.actor_id, session.version, {
        interaction_id: input.interaction_id,
      });
      return session;
    });
  }

  // Link an acquired transcript (A1-5/A1-6). Idempotent on (session, transcript).
  async linkTranscript(input: {
    tenant_id: string;
    session_id: string;
    conversation_transcript_id: string;
    source: 'TEAMS_GRAPH' | 'EXTERNAL_PROVIDER';
    actor_id: string;
  }): Promise<{ linked: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockDraft(tx, input.tenant_id, input.session_id);
      const existing = await tx.screeningTranscriptLink.findFirst({
        where: {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          conversation_transcript_id: input.conversation_transcript_id,
        },
        select: { id: true },
      });
      if (existing !== null) return { linked: false };
      await tx.screeningTranscriptLink.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          conversation_transcript_id: input.conversation_transcript_id,
          source: input.source,
        },
      });
      await this.appendEvent(tx, session, 'TRANSCRIPT_LINKED', input.actor_id, session.version, {
        conversation_transcript_id: input.conversation_transcript_id,
        source: input.source,
      });
      return { linked: true };
    });
  }

  // §B.2 / A1-5 — persist AI-drafted findings with their citations under the
  // session version (the finding set changes, so confirmation CAS sees it).
  async saveAiDraftedFindings(input: {
    tenant_id: string;
    session_id: string;
    actor_id: string;
    generation: AiGenerationInput;
    findings: AiDraftedFindingInput[];
    // A1-5 — the CI run id: the same run never drafts twice (replay converges).
    generation_id?: string;
  }): Promise<{ version: number; finding_ids: string[]; replayed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Lock first, then bump at the locked version: a system draft never loses
      // a CAS race against a concurrent recruiter edit.
      const current = await this.lockDraft(tx, input.tenant_id, input.session_id);
      if (input.generation_id !== undefined) {
        const prior = await tx.screeningAiGeneration.findFirst({
          where: { id: input.generation_id, tenant_id: input.tenant_id, session_id: input.session_id },
          select: { id: true },
        });
        if (prior !== null) {
          const rows = await tx.screeningFinding.findMany({
            where: { tenant_id: input.tenant_id, session_id: input.session_id, generation_id: prior.id },
            select: { id: true },
            orderBy: { created_at: 'asc' },
          });
          return { version: current.version, finding_ids: rows.map((r) => r.id), replayed: true };
        }
      }
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, current.version);
      const generationId = await this.insertGeneration(
        tx,
        session,
        input.actor_id,
        input.generation,
        input.findings.length,
        input.generation_id,
      );
      const ids: string[] = [];
      for (const f of input.findings) {
        const id = uuidv7();
        ids.push(id);
        await tx.screeningFinding.create({
          data: {
            id,
            tenant_id: input.tenant_id,
            session_id: input.session_id,
            skill_raw: f.skill_raw,
            basis: f.basis,
            observation_raw: f.observation_raw,
            demonstration_raw: null,
            limitations_raw: f.limitations_raw,
            origin: 'AI_DRAFTED',
            review_status: 'DRAFT',
            evidence_source: f.evidence_source,
            ai_original: {
              skill_raw: f.skill_raw,
              basis: f.basis,
              observation_raw: f.observation_raw,
              limitations_raw: f.limitations_raw,
            },
            generation_id: generationId,
          },
        });
        for (const c of f.citations) {
          await tx.screeningFindingCitation.create({
            data: { id: uuidv7(), tenant_id: input.tenant_id, finding_id: id, ...c },
          });
        }
      }
      await this.appendEvent(tx, session, 'FINDINGS_DRAFTED', input.actor_id, session.version, {
        generation_id: generationId,
        finding_count: ids.length,
      });
      return { version: session.version, finding_ids: ids, replayed: false };
    });
  }

  // §B.2 — the recruiter's review of an AI draft: accept as drafted (CONFIRMED)
  // or reject (REJECTED). Editing goes through editFinding (→ EDITED).
  async reviewAiFinding(input: {
    tenant_id: string;
    session_id: string;
    finding_id: string;
    expected_version: number;
    actor_id: string;
    outcome: 'CONFIRMED' | 'REJECTED';
  }): Promise<{ finding: ScreeningFindingRow; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.bumpDraft(tx, input.tenant_id, input.session_id, input.expected_version);
      const current = await tx.screeningFinding.findFirst({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        select: { origin: true },
      });
      if (current === null) throw new ScreeningGuardError('finding_not_found');
      if (current.origin !== 'AI_DRAFTED') throw new ScreeningGuardError('not_ai_finding');
      const now = new Date();
      await tx.screeningFinding.updateMany({
        where: { id: input.finding_id, session_id: input.session_id, tenant_id: input.tenant_id },
        data: { review_status: input.outcome, reviewed_by_actor_id: input.actor_id, reviewed_at: now, updated_at: now },
      });
      await this.appendEvent(tx, session, 'FINDING_REVIEWED', input.actor_id, session.version, {
        finding_id: input.finding_id,
        outcome: input.outcome,
      });
      const finding = (await tx.screeningFinding.findFirstOrThrow({
        where: { id: input.finding_id, tenant_id: input.tenant_id },
      })) as ScreeningFindingRow;
      return { finding, version: session.version };
    });
  }

  // R-B — retention: with no tenant retention policy, the screening AI content
  // (question plan, notes, suggestions) is deleted once the session is
  // CONFIRMED or VOIDED. The generation ledger (provenance metadata) and the
  // citation coordinates survive (CI v1.2 §8.2). Governed delete path —
  // confinement-spec allowlisted.
  async deleteSessionAiContent(tenantId: string, sessionId: string): Promise<{ deleted: number }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.loadSession(tx, tenantId, sessionId);
      if (session.state === 'DRAFT') return { deleted: 0 };
      const a = await tx.screeningAssistSuggestion.deleteMany({ where: { tenant_id: tenantId, session_id: sessionId } });
      const n = await tx.screeningNote.deleteMany({ where: { tenant_id: tenantId, session_id: sessionId } });
      const q = await tx.screeningQuestion.deleteMany({ where: { tenant_id: tenantId, session_id: sessionId } });
      return { deleted: a.count + n.count + q.count };
    });
  }

  // ---- publication (directive §7) -------------------------------------

  async listPendingPublicationIds(tenantId: string, sessionId: string): Promise<string[]> {
    const rows = await this.prisma.screeningEvidencePublication.findMany({
      where: { tenant_id: tenantId, session_id: sessionId, state: 'PENDING' },
      select: { id: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => r.id);
  }

  // One attempt for one intent. The intent row is locked FOR UPDATE for the whole
  // attempt, so concurrent attempts serialize; a non-PENDING intent is skipped.
  // `attempt` performs the trust write from the PINNED intent and classifies the
  // outcome; its result is recorded in this same screening transaction.
  async runPublicationAttempt(input: {
    tenant_id: string;
    publication_id: string;
    actor_id: string;
    now: () => Date;
    attempt: (
      intent: ScreeningPublicationRow,
    ) => Promise<{ outcome: 'published'; written: boolean } | { outcome: 'conflict' } | { outcome: 'failed'; error_code: string }>;
  }): Promise<{ publication_id: string; state: string; skipped: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "technical_screening"."ScreeningEvidencePublication"
         WHERE id = ${input.publication_id}::uuid AND tenant_id = ${input.tenant_id}::uuid
         FOR UPDATE`;
      if (locked.length === 0) throw new ScreeningGuardError('not_found');
      const intent = (await tx.screeningEvidencePublication.findFirstOrThrow({
        where: { id: input.publication_id, tenant_id: input.tenant_id },
      })) as ScreeningPublicationRow;
      if (intent.state !== 'PENDING') {
        return { publication_id: intent.id, state: intent.state, skipped: true };
      }
      const session = await this.loadSession(tx, input.tenant_id, intent.session_id);
      const result = await input.attempt(intent);
      const at = input.now();
      const base = { publication_id: intent.id, finding_id: intent.finding_id };
      if (result.outcome === 'published') {
        await tx.screeningEvidencePublication.update({
          where: { id: intent.id },
          data: {
            state: 'PUBLISHED',
            published_at: at,
            attempt_count: { increment: 1 },
            last_attempt_at: at,
            last_error_code: null,
          },
        });
        await this.appendEvent(tx, session, 'FINDING_PUBLISHED', input.actor_id, session.version, {
          ...base,
          written: result.written,
        });
        return { publication_id: intent.id, state: 'PUBLISHED', skipped: false };
      }
      if (result.outcome === 'conflict') {
        await tx.screeningEvidencePublication.update({
          where: { id: intent.id },
          data: {
            state: 'CONFLICT',
            attempt_count: { increment: 1 },
            last_attempt_at: at,
            last_error_code: 'IDEMPOTENCY_KEY_CONFLICT',
          },
        });
        await this.appendEvent(tx, session, 'PUBLICATION_CONFLICT', input.actor_id, session.version, base);
        return { publication_id: intent.id, state: 'CONFLICT', skipped: false };
      }
      await tx.screeningEvidencePublication.update({
        where: { id: intent.id },
        data: {
          attempt_count: { increment: 1 },
          last_attempt_at: at,
          last_error_code: result.error_code,
        },
      });
      await this.appendEvent(tx, session, 'PUBLICATION_ATTEMPT_FAILED', input.actor_id, session.version, {
        ...base,
        error_code: result.error_code,
      });
      return { publication_id: intent.id, state: 'PENDING', skipped: false };
    }, PUBLICATION_TX_OPTIONS);
  }

  // ---- talent merge re-key (directive §10.3) ---------------------------

  // TR-2a-B3b operational repoint contract: move this tenant's sessions from the
  // husk record to the survivor. Publication intents are NOT re-keyed (they keep
  // talent_record_id_at_confirm). The terminal-session trigger permits exactly
  // this column. No unique key on the column → no collision → removed_rows [].
  async repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }> {
    const params: unknown[] = [args.to_record_id, args.from_record_id, args.tenant_id];
    let idFilter = '';
    if (args.only_ids && args.only_ids.length > 0) {
      params.push(args.only_ids);
      idFilter = `AND id = ANY($${params.length}::uuid[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "technical_screening"."ScreeningSession"
          SET talent_record_id = $1::uuid, updated_at = now()
        WHERE talent_record_id = $2::uuid AND tenant_id = $3::uuid ${idFilter}
        RETURNING id`,
      ...params,
    );
    return { repointed_ids: rows.map((r) => r.id), removed_rows: [] };
  }

  // ---- internals ------------------------------------------------------

  private async bumpDraft(
    tx: ScreeningTx,
    tenantId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<ScreeningSessionRow> {
    const res = await tx.screeningSession.updateMany({
      where: { id: sessionId, tenant_id: tenantId, state: 'DRAFT', version: expectedVersion },
      data: { version: expectedVersion + 1, updated_at: new Date() },
    });
    if (res.count !== 1) await this.throwGuardFailure(tx, tenantId, sessionId);
    return this.loadSession(tx, tenantId, sessionId);
  }

  // A DRAFT guard WITHOUT a version check (question plan / notes / suggestions
  // are not part of the confirmed set): the UPDATE locks the session row, and a
  // non-DRAFT or absent session is refused exactly as bumpDraft refuses.
  private async lockDraft(tx: ScreeningTx, tenantId: string, sessionId: string): Promise<ScreeningSessionRow> {
    const res = await tx.screeningSession.updateMany({
      where: { id: sessionId, tenant_id: tenantId, state: 'DRAFT' },
      data: { updated_at: new Date() },
    });
    if (res.count !== 1) {
      const current = await tx.screeningSession.findFirst({
        where: { id: sessionId, tenant_id: tenantId },
        select: { state: true },
      });
      throw new ScreeningGuardError(current === null ? 'not_found' : 'state_invalid');
    }
    return this.loadSession(tx, tenantId, sessionId);
  }

  private async insertGeneration(
    tx: ScreeningTx,
    session: { id: string; tenant_id: string },
    actorId: string,
    g: AiGenerationInput,
    outputCount: number,
    suppliedId?: string,
  ): Promise<string> {
    const id = suppliedId ?? uuidv7();
    await tx.screeningAiGeneration.create({
      data: {
        id,
        tenant_id: session.tenant_id,
        session_id: session.id,
        kind: g.kind,
        provider: g.provider,
        model: g.model,
        provider_request_id: g.provider_request_id,
        prompt_version: g.prompt_version,
        input_sha256: g.input_sha256,
        used_talent_profile: g.used_talent_profile,
        used_requisition: g.used_requisition,
        used_transcript: g.used_transcript,
        output_count: outputCount,
        actor_id: actorId,
      },
    });
    return id;
  }

  private async throwGuardFailure(tx: ScreeningTx, tenantId: string, sessionId: string): Promise<never> {
    const current = await tx.screeningSession.findFirst({
      where: { id: sessionId, tenant_id: tenantId },
      select: { state: true },
    });
    if (current === null) throw new ScreeningGuardError('not_found');
    if (current.state !== 'DRAFT') throw new ScreeningGuardError('state_invalid');
    throw new ScreeningGuardError('version_conflict');
  }

  private async loadSession(tx: ScreeningTx, tenantId: string, sessionId: string): Promise<ScreeningSessionRow> {
    const row = await tx.screeningSession.findFirst({ where: { id: sessionId, tenant_id: tenantId } });
    if (row === null) throw new ScreeningGuardError('not_found');
    return row as ScreeningSessionRow;
  }

  private async appendEvent(
    tx: ScreeningTx,
    session: { id: string; tenant_id: string },
    eventType: ScreeningEventType,
    actorId: string,
    sessionVersion: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.screeningEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: session.tenant_id,
        session_id: session.id,
        event_type: eventType,
        actor_id: actorId,
        session_version: sessionVersion,
        payload: payload as object,
      },
    });
  }
}
