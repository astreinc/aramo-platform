import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId, hashCanonicalizedBody } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  ConversationIntelligenceRunRepository,
  NORMALIZED_TRANSCRIPT_SOURCE,
  type CiRunRow,
  type NormalizedTranscriptSource,
} from '@aramo/conversation-intelligence';
import { IdempotencyService } from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  ScreeningAiService,
  TechnicalScreeningService,
  type ScreeningCitationRow,
  type ScreeningFindingRow,
  type ScreeningGenerationRow,
  type ScreeningNoteRow,
  type ScreeningPublicationRow,
  type ScreeningQuestionRow,
  type ScreeningSessionRow,
  type ScreeningSuggestionRow,
  type ScreeningTranscriptLinkRow,
} from '@aramo/technical-screening';

import { ScreeningAccessService } from './screening-access.service.js';
import { ScreeningContextReader } from './screening-context.reader.js';
import { ScreeningRetentionService } from './screening-retention.service.js';
import {
  ScreeningMeetingService,
  type ScreeningCaptureModes,
  type ScreeningMeetingScheduleResult,
  type ScreeningTranscriptCheckItem,
} from './screening-meeting.service.js';

// TIP-E2E INC-3 — Manual Technical Screening HTTP surface
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8/§9). Every route: JwtAuthGuard +
// EntitlementGuard + RolesGuard, @RequireCapability('ats'), @RequireScopes, the
// in-handler recruiter-only check, and row-level tenant+site access with 404
// concealment (ScreeningAccessService). The acting tenant and actor come ONLY
// from the verified auth context. Manual capture — no AI, nothing inferred; no
// write into Examination, Pipeline or Submittal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScreeningSessionView {
  id: string;
  talent_record_id: string;
  interaction_id: string | null;
  requisition_id: string | null;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string;
  confirmed_by_actor_id: string | null;
  confirmed_at: string | null;
  confirmed_version: number | null;
  voided_by_actor_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

export interface ScreeningFindingView {
  id: string;
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
  // INC-3 A1 §B.2 — the three provenance axes; ai_original is the retained AI
  // text of an AI draft (shown beside any recruiter edit).
  origin: string;
  review_status: string | null;
  evidence_source: string;
  ai_original: unknown | null;
  reviewed_by_actor_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

// INC-3 A1 — citation COORDINATES only; excerpt text needs screening:transcript:read.
export interface ScreeningCitationView {
  id: string;
  finding_id: string;
  conversation_transcript_id: string;
  utterance_id: string;
  start_offset: number;
  end_offset: number;
}

export interface ScreeningQuestionView {
  id: string;
  text: string;
  skill_ref: string | null;
  intent: string;
  origin: string;
  status: string;
  edited: boolean;
  position: number;
  generation_id: string | null;
}

export interface ScreeningNoteView {
  id: string;
  body: string;
  created_at: string;
}

export interface ScreeningSuggestionView {
  id: string;
  generation_id: string;
  text: string;
  trigger_kind: string;
  trigger_ref: unknown;
  action: string | null;
  actioned_at: string | null;
  created_at: string;
}

// Provenance of each model call: provider + model ACTUALLY used.
export interface ScreeningGenerationView {
  id: string;
  kind: string;
  provider: string;
  model: string;
  prompt_version: string;
  used_talent_profile: boolean;
  used_requisition: boolean;
  used_transcript: boolean;
  output_count: number;
  created_at: string;
}

export interface ScreeningTranscriptLinkView {
  conversation_transcript_id: string;
  source: string;
  created_at: string;
}

// INC-3 A1-5 — the CI screening-profile run status per linked transcript
// (provider + model as recorded on the run; never the transcript text).
export interface ScreeningAnalysisView {
  run_id: string;
  conversation_transcript_id: string;
  status: string;
  last_error_code: string | null;
  model_provider: string;
  model_name: string;
  created_at: string;
  completed_at: string | null;
}

// INC-3 A1-5 — the cited transcript excerpt (screening:transcript:read only).
export interface ScreeningCitationExcerptView {
  citation_id: string;
  conversation_transcript_id: string;
  utterance_id: string;
  speaker_role: string;
  excerpt: string;
  utterance_text: string;
}

export interface ScreeningPublicationView {
  id: string;
  finding_id: string;
  evidence_record_id: string;
  state: string;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null;
  published_at: string | null;
  created_at: string;
  // The published evidence's CURRENT Talent Trust status (directive §5); null
  // until published.
  trust_status: string | null;
}

export interface ScreeningSessionDetailView {
  session: ScreeningSessionView;
  findings: ScreeningFindingView[];
  publications: ScreeningPublicationView[];
  citations: ScreeningCitationView[];
  questions: ScreeningQuestionView[];
  notes: ScreeningNoteView[];
  suggestions: ScreeningSuggestionView[];
  generations: ScreeningGenerationView[];
  transcripts: ScreeningTranscriptLinkView[];
  analyses: ScreeningAnalysisView[];
}

function citationView(c: ScreeningCitationRow): ScreeningCitationView {
  return {
    id: c.id,
    finding_id: c.finding_id,
    conversation_transcript_id: c.conversation_transcript_id,
    utterance_id: c.utterance_id,
    start_offset: c.start_offset,
    end_offset: c.end_offset,
  };
}

function questionView(q: ScreeningQuestionRow): ScreeningQuestionView {
  return {
    id: q.id,
    text: q.text,
    skill_ref: q.skill_ref,
    intent: q.intent,
    origin: q.origin,
    status: q.status,
    edited: q.edited,
    position: q.position,
    generation_id: q.generation_id,
  };
}

function noteView(n: ScreeningNoteRow): ScreeningNoteView {
  return { id: n.id, body: n.body, created_at: n.created_at.toISOString() };
}

function suggestionView(x: ScreeningSuggestionRow): ScreeningSuggestionView {
  return {
    id: x.id,
    generation_id: x.generation_id,
    text: x.text,
    trigger_kind: x.trigger_kind,
    trigger_ref: x.trigger_ref,
    action: x.action,
    actioned_at: x.actioned_at === null ? null : x.actioned_at.toISOString(),
    created_at: x.created_at.toISOString(),
  };
}

function generationView(g: ScreeningGenerationRow): ScreeningGenerationView {
  return {
    id: g.id,
    kind: g.kind,
    provider: g.provider,
    model: g.model,
    prompt_version: g.prompt_version,
    used_talent_profile: g.used_talent_profile,
    used_requisition: g.used_requisition,
    used_transcript: g.used_transcript,
    output_count: g.output_count,
    created_at: g.created_at.toISOString(),
  };
}

function analysisView(r: CiRunRow): ScreeningAnalysisView {
  return {
    run_id: r.id,
    conversation_transcript_id: r.conversation_transcript_id,
    status: r.status,
    last_error_code: r.last_error_code,
    model_provider: r.model_provider,
    model_name: r.model_name,
    created_at: r.created_at.toISOString(),
    completed_at: r.completed_at === null ? null : r.completed_at.toISOString(),
  };
}

function transcriptLinkView(t: ScreeningTranscriptLinkRow): ScreeningTranscriptLinkView {
  return { conversation_transcript_id: t.conversation_transcript_id, source: t.source, created_at: t.created_at.toISOString() };
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function sessionView(s: ScreeningSessionRow): ScreeningSessionView {
  return {
    id: s.id,
    talent_record_id: s.talent_record_id,
    interaction_id: s.interaction_id,
    requisition_id: s.requisition_id,
    state: s.state,
    version: s.version,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
    created_by_actor_id: s.created_by_actor_id,
    confirmed_by_actor_id: s.confirmed_by_actor_id,
    confirmed_at: iso(s.confirmed_at),
    confirmed_version: s.confirmed_version,
    voided_by_actor_id: s.voided_by_actor_id,
    voided_at: iso(s.voided_at),
    void_reason: s.void_reason,
  };
}

function findingView(f: ScreeningFindingRow): ScreeningFindingView {
  return {
    id: f.id,
    skill_raw: f.skill_raw,
    basis: f.basis,
    observation_raw: f.observation_raw,
    demonstration_raw: f.demonstration_raw,
    limitations_raw: f.limitations_raw,
    origin: f.origin,
    review_status: f.review_status,
    evidence_source: f.evidence_source,
    ai_original: f.ai_original,
    reviewed_by_actor_id: f.reviewed_by_actor_id,
    reviewed_at: iso(f.reviewed_at),
    created_at: f.created_at.toISOString(),
    updated_at: f.updated_at.toISOString(),
  };
}

function publicationView(p: ScreeningPublicationRow, trustStatus: string | null): ScreeningPublicationView {
  return {
    id: p.id,
    finding_id: p.finding_id,
    evidence_record_id: p.evidence_record_id,
    state: p.state,
    attempt_count: p.attempt_count,
    last_attempt_at: iso(p.last_attempt_at),
    last_error_code: p.last_error_code,
    published_at: iso(p.published_at),
    created_at: p.created_at.toISOString(),
    trust_status: trustStatus,
  };
}

function requireIdempotencyKey(key: string | undefined, requestId: string): string {
  if (key === undefined || key.length === 0) {
    throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key header is required', 400, {
      requestId,
      details: { missing_field: 'Idempotency-Key' },
    });
  }
  if (!UUID_RE.test(key)) {
    throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be a UUID', 400, {
      requestId,
      details: { invalid_field: 'Idempotency-Key' },
    });
  }
  return key;
}

type Body = Record<string, unknown> | undefined;

@Controller('v1/talent-records/:talentId/screening-sessions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentScreeningSessionsController {
  constructor(
    private readonly screening: TechnicalScreeningService,
    private readonly access: ScreeningAccessService,
    private readonly context: ScreeningContextReader,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:create')
  async create(
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ScreeningSessionView> {
    this.access.assertRecruiter(auth, requestId);
    const talent = await this.access.talentFor(auth, talentId, requestId);
    this.access.assertLive(talent, requestId);
    const interaction = body?.['interaction_id'];
    if (interaction !== undefined && interaction !== null && (typeof interaction !== 'string' || !UUID_RE.test(interaction))) {
      throw new AramoError('VALIDATION_ERROR', 'interaction_id must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'interaction_id' },
      });
    }
    // INC-3 A1 §B.1 :71 — OPTIONAL requisition, used ONLY for question
    // tailoring; must be inside the actor's requisition visibility (else 404).
    const requisition = body?.['requisition_id'];
    let requisitionId: string | null = null;
    if (requisition !== undefined && requisition !== null) {
      if (typeof requisition !== 'string' || !UUID_RE.test(requisition)) {
        throw new AramoError('VALIDATION_ERROR', 'requisition_id must be a UUID', 400, {
          requestId,
          details: { invalid_field: 'requisition_id' },
        });
      }
      const visibility = await req.resolveVisibility!();
      const ctx = await this.context.requisitionContext({ tenant_id: auth.tenant_id, visibility, requisition_id: requisition });
      if (ctx === null) throw new AramoError('NOT_FOUND', 'not found', 404, { requestId });
      requisitionId = requisition;
    }
    const session = await this.screening.createSession({
      tenant_id: auth.tenant_id,
      site_id: talent.site_id,
      talent_record_id: talent.id,
      interaction_id: typeof interaction === 'string' ? interaction : null,
      requisition_id: requisitionId,
      actor_id: auth.sub,
    });
    return sessionView(session);
  }

  @Get()
  @RequireScopes('screening:read')
  async list(
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ items: ScreeningSessionView[] }> {
    this.access.assertRecruiter(auth, requestId);
    const talent = await this.access.talentFor(auth, talentId, requestId);
    const sessions = await this.screening.listForTalent(auth.tenant_id, talent.id);
    return { items: sessions.map(sessionView) };
  }
}

@Controller('v1/screening-sessions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ScreeningSessionController {
  constructor(
    private readonly screening: TechnicalScreeningService,
    private readonly access: ScreeningAccessService,
    private readonly idempotency: IdempotencyService,
    private readonly ai: ScreeningAiService,
    private readonly context: ScreeningContextReader,
    private readonly meetings: ScreeningMeetingService,
    private readonly ciRuns: ConversationIntelligenceRunRepository,
    @Inject(NORMALIZED_TRANSCRIPT_SOURCE) private readonly transcriptSource: NormalizedTranscriptSource,
    private readonly retention: ScreeningRetentionService,
  ) {}

  // A1-5 / D.3 — the transcript excerpt behind ONE citation of this session's
  // findings. Requires screening:transcript:read (B.7). Reads the stored,
  // hash-verified normalized artifact; a deleted or unverifiable transcript is
  // never reconstructed (404 with the reason).
  @Get(':id/citations/:citationId/excerpt')
  @RequireScopes('screening:read', 'screening:transcript:read')
  async citationExcerpt(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('citationId', ParseUUIDPipe) citationId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningCitationExcerptView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    const d = await this.screening.getDetail(auth.tenant_id, id, requestId);
    const citation = d.citations.find((c) => c.id === citationId);
    if (citation === undefined) throw new AramoError('NOT_FOUND', 'not found', 404, { requestId });
    const load = await this.transcriptSource.load(auth.tenant_id, citation.conversation_transcript_id);
    if (load.status !== 'ready') {
      throw new AramoError('NOT_FOUND', 'the cited transcript is not available', 404, {
        requestId,
        details: { reason: `transcript_${load.status}` },
      });
    }
    const utterance = load.view.utterances.find((u) => u.utterance_id === citation.utterance_id);
    if (utterance === undefined) {
      throw new AramoError('NOT_FOUND', 'the cited utterance is not available', 404, { requestId });
    }
    return {
      citation_id: citation.id,
      conversation_transcript_id: citation.conversation_transcript_id,
      utterance_id: citation.utterance_id,
      speaker_role: utterance.speaker_role,
      excerpt: utterance.text.slice(citation.start_offset, citation.end_offset),
      utterance_text: utterance.text,
    };
  }

  // ---- INC-3 A1-4 — Teams meeting (existing Outlook scheduling) -----------

  // G-3 — schedule the screening interview through the EXISTING delegated
  // Outlook scheduling integration (contacting consent, idempotency ledger,
  // organizer = the acting recruiter). Associations: Talent × ScreeningSession,
  // Requisition optional (A1 Part F).
  @Post(':id/meeting')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit', 'communication:meeting:create')
  async scheduleMeeting(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ meeting: ScreeningMeetingScheduleResult; session: ScreeningSessionDetailView }> {
    this.access.assertRecruiter(auth, requestId);
    const { session } = await this.access.sessionFor(auth, id, requestId);
    const meeting = await this.meetings.schedule({ auth, session, body, requestId });
    return { meeting, session: await this.detail(auth, id, requestId) };
  }

  // §1.1 / R-C — the honest capture-mode statuses for this recruiter.
  @Get(':id/capture-modes')
  @RequireScopes('screening:read')
  async captureModes(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningCaptureModes> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    return this.meetings.captureModes(auth);
  }

  // C-1 — post-meeting Teams transcript retrieval (organizer only; transcription
  // consent and the meeting_artifacts capability, fail closed).
  @Post(':id/transcripts/check')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:edit', 'screening:transcript:read')
  async checkTranscripts(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ items: ScreeningTranscriptCheckItem[]; session: ScreeningSessionDetailView }> {
    this.access.assertRecruiter(auth, requestId);
    const { session } = await this.access.sessionFor(auth, id, requestId);
    const result = await this.meetings.checkTranscripts({ auth, session, requestId });
    return { items: result.items, session: await this.detail(auth, id, requestId) };
  }

  // ---- INC-3 A1-2/A1-3 — question plan -----------------------------------

  // G-1/G-2 — generate (or regenerate) the AI question plan from the optional
  // requisition and, when include_talent_profile is not false, the minimized
  // talent profile (which requires ai_processing — R-A, fail closed).
  @Post(':id/questions/generate')
  @RequireScopes('screening:edit')
  async generateQuestions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const { session, talent } = await this.access.sessionFor(auth, id, requestId);
    const includeTalent = body?.['include_talent_profile'] !== false;
    let requisition = null;
    if (session.requisition_id !== null) {
      const visibility = await req.resolveVisibility!();
      requisition = await this.context.requisitionContext({
        tenant_id: auth.tenant_id,
        visibility,
        requisition_id: session.requisition_id,
      });
    }
    const talentContext = includeTalent
      ? await this.context.talentContext({ tenant_id: auth.tenant_id, talent_record_id: talent.id })
      : null;
    await this.ai.generateQuestionPlan({
      tenant_id: auth.tenant_id,
      session_id: id,
      talent_record_id: talent.id,
      actor_id: auth.sub,
      requisition,
      talent: talentContext,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Post(':id/questions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit')
  async addQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.addQuestion({
      tenant_id: auth.tenant_id,
      session_id: id,
      actor_id: auth.sub,
      text: body?.['text'],
      skill_ref: body?.['skill_ref'],
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // Edit text, select, deselect (PROPOSED) or remove (REMOVED) a question.
  @Patch(':id/questions/:questionId')
  @RequireScopes('screening:edit')
  async updateQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.updateQuestion({
      tenant_id: auth.tenant_id,
      session_id: id,
      question_id: questionId,
      actor_id: auth.sub,
      ...(body?.['text'] !== undefined ? { text: body['text'] } : {}),
      ...(body?.['status'] !== undefined ? { status: body['status'] } : {}),
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // ---- INC-3 A1-2/A1-3 — interview notes and assistance ------------------

  @Post(':id/notes')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit')
  async addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.addNote({ tenant_id: auth.tenant_id, session_id: id, actor_id: auth.sub, body: body?.['body'], requestId });
    return this.detail(auth, id, requestId);
  }

  // G-4 — AI follow-up suggestions from a recruiter note (recruiter-notes mode;
  // no transcript involved). ai_processing-gated, fail closed.
  @Post(':id/suggestions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit')
  async suggest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const { talent } = await this.access.sessionFor(auth, id, requestId);
    const noteId = body?.['note_id'];
    if (typeof noteId !== 'string' || !UUID_RE.test(noteId)) {
      throw new AramoError('VALIDATION_ERROR', 'note_id must be a UUID', 400, { requestId, details: { invalid_field: 'note_id' } });
    }
    const d = await this.screening.getDetail(auth.tenant_id, id, requestId);
    const note = d.notes.find((n) => n.id === noteId);
    if (note === undefined) throw new AramoError('NOT_FOUND', 'not found', 404, { requestId });
    const plan = d.questions.filter((q) => q.status === 'SELECTED').map((q) => q.text);
    await this.ai.suggestFollowUps({
      tenant_id: auth.tenant_id,
      session_id: id,
      talent_record_id: talent.id,
      actor_id: auth.sub,
      trigger: { kind: 'NOTE', note_id: note.id, text: note.body },
      plan,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Patch(':id/suggestions/:suggestionId')
  @RequireScopes('screening:edit')
  async actionSuggestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.actionSuggestion({
      tenant_id: auth.tenant_id,
      session_id: id,
      suggestion_id: suggestionId,
      actor_id: auth.sub,
      action: body?.['action'],
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // §B.2 — accept an AI draft as drafted (CONFIRMED) or reject it (REJECTED).
  // Editing an AI draft uses PATCH :id/findings/:findingId (→ EDITED).
  @Post(':id/findings/:findingId/review')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:edit')
  async reviewFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.reviewAiFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      finding_id: findingId,
      version: body?.['version'],
      outcome: body?.['outcome'],
      actor_id: auth.sub,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Get(':id')
  @RequireScopes('screening:read')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    return this.detail(auth, id, requestId);
  }

  @Post(':id/findings')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit')
  async addFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.addFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      actor_id: auth.sub,
      finding: findingInput(body),
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Patch(':id/findings/:findingId')
  @RequireScopes('screening:edit')
  async editFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.editFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      finding_id: findingId,
      version: body?.['version'],
      actor_id: auth.sub,
      finding: findingInput(body),
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Delete(':id/findings/:findingId')
  @RequireScopes('screening:edit')
  async removeFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Query('version') version: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    const parsed = version !== undefined && /^\d+$/.test(version) ? Number(version) : version;
    await this.screening.removeFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      finding_id: findingId,
      version: parsed,
      actor_id: auth.sub,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // Directive §6 + §7(a) — confirm (atomic with the pinned intents), then ONE
  // synchronous publication attempt. A publication failure never rolls the
  // confirmation back: the intent stays PENDING and the response shows it.
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:confirm')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const key = requireIdempotencyKey(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody({ route: 'screening.confirm', id, body: body ?? {} });
    const lookup = await this.idempotency.lookup({ tenant_id: auth.tenant_id, key, request_hash: requestHash, requestId });
    if (lookup.kind === 'replay') return lookup.response_body as ScreeningSessionDetailView;

    const { talent } = await this.access.sessionFor(auth, id, requestId);
    this.access.assertLive(talent, requestId);
    await this.screening.confirm({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      confirmed_finding_ids: body?.['confirmed_finding_ids'],
      observations_confirmed: body?.['observations_confirmed'],
      actor_id: auth.sub,
      requestId,
    });
    await this.screening.publishPending({ tenant_id: auth.tenant_id, session_id: id, actor_id: auth.sub, requestId });
    // A1-8 / R-B — terminal retention (AI content + linked transcript artifacts).
    await this.retention.applyTerminalRetention(auth.tenant_id, id);
    const response = await this.detail(auth, id, requestId);
    await this.idempotency.persist({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:edit')
  async voidSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.voidSession({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      reason: body?.['reason'],
      actor_id: auth.sub,
      requestId,
    });
    // A1-8 / R-B — terminal retention (AI content + linked transcript artifacts).
    await this.retention.applyTerminalRetention(auth.tenant_id, id);
    return this.detail(auth, id, requestId);
  }

  // Directive §7(b) — retry PENDING intents; no re-attestation. Idempotent by
  // construction (a PUBLISHED/CONFLICT intent is skipped); the Idempotency-Key
  // replays the first response for a duplicate request.
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:confirm')
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const key = requireIdempotencyKey(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody({ route: 'screening.publish', id });
    const lookup = await this.idempotency.lookup({ tenant_id: auth.tenant_id, key, request_hash: requestHash, requestId });
    if (lookup.kind === 'replay') return lookup.response_body as ScreeningSessionDetailView;

    await this.access.sessionFor(auth, id, requestId);
    await this.screening.publishPending({ tenant_id: auth.tenant_id, session_id: id, actor_id: auth.sub, requestId });
    const response = await this.detail(auth, id, requestId);
    await this.idempotency.persist({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  private async detail(auth: AuthContextType, id: string, requestId: string): Promise<ScreeningSessionDetailView> {
    const d = await this.screening.getDetail(auth.tenant_id, id, requestId);
    const statuses = await this.access.trustStatuses(auth.tenant_id, d.publications);
    return {
      session: sessionView(d.session),
      findings: d.findings.map(findingView),
      publications: d.publications.map((p) => publicationView(p, statuses.get(p.id) ?? null)),
      citations: d.citations.map(citationView),
      questions: d.questions.map(questionView),
      notes: d.notes.map(noteView),
      suggestions: d.suggestions.map(suggestionView),
      generations: d.generations.map(generationView),
      transcripts: d.transcripts.map(transcriptLinkView),
      analyses: (await this.ciRuns.listScreeningRuns(auth.tenant_id, id)).map(analysisView),
    };
  }
}

function findingInput(body: Body) {
  return {
    skill_raw: body?.['skill_raw'],
    basis: body?.['basis'],
    observation_raw: body?.['observation_raw'],
    demonstration_raw: body?.['demonstration_raw'],
    limitations_raw: body?.['limitations_raw'],
  };
}
