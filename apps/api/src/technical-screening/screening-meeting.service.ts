import { Injectable, Logger } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import {
  ConversationTranscriptService,
  TranscriptNormalizationService,
  type ConversationTranscriptRow,
} from '@aramo/conversation-transcript';
import {
  TechnicalScreeningService,
  type ScreeningSessionRow,
} from '@aramo/technical-screening';

import { NormalizedTranscriptReadyHandler } from '../conversation-intelligence/normalized-transcript-ready.handler.js';
import {
  MICROSOFT_TEAMS_PROVIDER_KEY,
  MICROSOFT_TEAMS_TRANSCRIPT_FORMAT,
} from '../conversation-transcript/teams/teams-transcript.constants.js';
import { MeetingArtifactsService } from '../microsoft/meeting-artifacts.service.js';
import { mapMicrosoftError } from '../microsoft/microsoft-error-mapper.js';
import { MicrosoftSchedulingService } from '../microsoft/microsoft-scheduling.service.js';

import { ScreeningAiConsentAdapter } from './screening-ai-consent.adapter.js';

// TIP-E2E INC-3 A1-4/A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Parts E/F, §5,
// §1.1, R-C) — composition of the screening session with the EXISTING Outlook
// scheduling integration and the delegated Teams meeting-artifact capability.
//   - Scheduling reuses MicrosoftSchedulingService unchanged in its guarantees
//     (idempotency ledger, contacting consent, organizer from the JWT); only the
//     association is Talent × ScreeningSession with Requisition optional.
//   - Transcript retrieval is post-meeting, organizer-only, capability-gated and
//     `transcription`-consent-gated (fail closed), then enters B3/B4 unchanged.
//   - Capture modes are reported honestly: nothing unconfigured is shown as live.

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CaptureModeStatus =
  | 'available'
  | 'not_granted'
  | 'not_connected'
  | 'reauth_required'
  | 'no_approved_provider';

export interface ScreeningCaptureModes {
  recruiter_notes: { status: 'available' };
  teams_post_meeting: { status: CaptureModeStatus };
  live_external_provider: { status: 'no_approved_provider' };
}

export interface ScreeningTranscriptCheckItem {
  conversation_transcript_id: string;
  provider_transcript_id: string;
  state: string;
  linked: boolean;
  // A1-5 — the CI screening-profile scheduling outcome ('queued' only when the
  // dark-by-default CI processing is enabled and configured).
  analysis: string | null;
}

export interface ScreeningMeetingScheduleResult {
  interaction_id: string;
  join_url: string | null;
  idempotent_replay: boolean;
  artifact_preparation: string;
  record_automatically: boolean;
}

@Injectable()
export class ScreeningMeetingService {
  private readonly logger = new Logger(ScreeningMeetingService.name);

  constructor(
    private readonly screening: TechnicalScreeningService,
    private readonly scheduling: MicrosoftSchedulingService,
    private readonly artifacts: MeetingArtifactsService,
    private readonly transcripts: ConversationTranscriptService,
    private readonly normalization: TranscriptNormalizationService,
    private readonly consent: ScreeningAiConsentAdapter,
    private readonly analysis: NormalizedTranscriptReadyHandler,
  ) {}

  async schedule(args: {
    auth: AuthContextType;
    session: ScreeningSessionRow;
    body: Record<string, unknown> | undefined;
    requestId: string;
  }): Promise<ScreeningMeetingScheduleResult> {
    const { auth, session, requestId } = args;
    if (session.state !== 'DRAFT') {
      throw new AramoError('SCREENING_SESSION_STATE_INVALID', 'the screening session is no longer a draft', 422, { requestId });
    }
    if (session.interaction_id !== null) {
      // Refused BEFORE any Outlook side effect — one meeting per session.
      throw new AramoError('SCREENING_SESSION_STATE_INVALID', 'a meeting is already linked to this screening session', 422, {
        requestId,
        details: { reason: 'meeting_already_linked' },
      });
    }
    const body = args.body ?? {};
    const subject = str(body['subject'], 'subject', 1, 1024, requestId);
    const start = iso(body['start_date_time'], 'start_date_time', requestId);
    const end = iso(body['end_date_time'], 'end_date_time', requestId);
    const timeZone = str(body['time_zone'], 'time_zone', 1, 100, requestId);
    const idempotencyKey = str(body['idempotency_key'], 'idempotency_key', 8, 200, requestId);
    const connectionId = body['connection_id'];
    if (connectionId !== undefined && (typeof connectionId !== 'string' || !UUID_RE.test(connectionId))) {
      throw invalid(requestId, 'connection_id');
    }

    let scheduled;
    try {
      scheduled = await this.scheduling.scheduleMeeting({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        ...(connectionId !== undefined ? { connection_id: connectionId as string } : {}),
        talent_record_id: session.talent_record_id,
        requisition_id: session.requisition_id,
        screening_session_id: session.id,
        subject,
        start_date_time: start,
        end_date_time: end,
        time_zone: timeZone,
        idempotency_key: idempotencyKey,
        authContext: auth,
        requestId,
      });
    } catch (err) {
      throw mapMicrosoftError(err, requestId, this.logger);
    }

    await this.screening.linkMeeting({
      tenant_id: auth.tenant_id,
      session_id: session.id,
      interaction_id: scheduled.interaction_id,
      actor_id: auth.sub,
      requestId,
    });

    // Best-effort, never fails the scheduled meeting. Auto-record is set only
    // when `recording` consent allows it (A1 §5).
    const recordingAllowed = await this.consent.isOperationAllowed(auth.tenant_id, session.talent_record_id, 'recording');
    const prepared = await this.artifacts.prepareScreeningMeeting({
      tenant_id: auth.tenant_id,
      organizer_id: auth.sub,
      interaction_id: scheduled.interaction_id,
      recording_allowed: recordingAllowed,
    });

    return {
      interaction_id: scheduled.interaction_id,
      join_url: scheduled.join_url,
      idempotent_replay: scheduled.idempotent_replay,
      artifact_preparation: prepared.status,
      record_automatically: prepared.record_automatically,
    };
  }

  async captureModes(auth: AuthContextType): Promise<ScreeningCaptureModes> {
    const status = await this.artifacts.capabilityStatus(auth.tenant_id, auth.sub);
    return {
      recruiter_notes: { status: 'available' },
      teams_post_meeting: { status: status === 'granted' ? 'available' : status },
      // R-C — no external capture vendor is approved or connected.
      live_external_provider: { status: 'no_approved_provider' },
    };
  }

  // Post-meeting Teams transcript check (organizer-triggered polling fallback).
  // Order: meeting linked → organizer == actor → `transcription` consent →
  // capability → Graph listing → B3 register/acquire → B4 normalize → link.
  async checkTranscripts(args: {
    auth: AuthContextType;
    session: ScreeningSessionRow;
    requestId: string;
  }): Promise<{ items: ScreeningTranscriptCheckItem[]; normalized: ScreeningTranscriptCheckItem[] }> {
    const { auth, session, requestId } = args;
    if (session.state !== 'DRAFT') {
      throw new AramoError('SCREENING_SESSION_STATE_INVALID', 'the screening session is no longer a draft', 422, { requestId });
    }
    if (session.interaction_id === null) {
      throw new AramoError('SCREENING_SESSION_STATE_INVALID', 'no meeting is linked to this screening session', 422, {
        requestId,
        details: { reason: 'no_meeting_linked' },
      });
    }
    const interactionId = session.interaction_id;
    const organizerId = await this.artifacts.organizerOf(auth.tenant_id, interactionId);
    if (organizerId === null) {
      throw new AramoError('MICROSOFT_MEETING_NOT_FOUND', 'scheduling meeting not found', 404, { requestId });
    }
    if (organizerId !== auth.sub) {
      throw new AramoError('MICROSOFT_MEETING_NOT_ORGANIZER', 'only the organizing recruiter may retrieve this meeting transcript', 403, {
        requestId,
      });
    }
    const transcriptionAllowed = await this.consent.isOperationAllowed(
      auth.tenant_id,
      session.talent_record_id,
      'transcription',
    );
    if (!transcriptionAllowed) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'transcription is not authorized for this talent', 403, {
        requestId,
        details: { reason: 'transcription_not_authorized' },
      });
    }

    const listing = await this.artifacts.listTranscriptRefs({
      tenant_id: auth.tenant_id,
      organizer_id: organizerId,
      acting_recruiter_id: auth.sub,
      interaction_id: interactionId,
      requestId,
    });

    const items: ScreeningTranscriptCheckItem[] = [];
    for (const ref of listing.transcripts) {
      let row: ConversationTranscriptRow = await this.transcripts.registerTranscriptAvailability({
        tenant_id: auth.tenant_id,
        interaction_id: interactionId,
        provider_key: MICROSOFT_TEAMS_PROVIDER_KEY,
        provider_transcript_id: ref.transcript_id,
        provider_resource_ref: `${interactionId}:${listing.online_meeting_id}`,
        source_type: 'provider_full_transcript',
        recording_dependency: 'not_required',
        ...(ref.created_date_time !== null ? { provider_generated_at: new Date(ref.created_date_time) } : {}),
      });
      if (ACQUIRABLE.has(row.state)) {
        row = await this.transcripts.acquire({
          tenant_id: auth.tenant_id,
          provider_key: MICROSOFT_TEAMS_PROVIDER_KEY,
          provider_transcript_id: ref.transcript_id,
          authorization: { transcription_authorized: true },
        });
      }
      if (NORMALIZABLE.has(row.state)) {
        row = await this.normalization.normalize({
          tenant_id: auth.tenant_id,
          transcript_id: row.id,
          source_format: MICROSOFT_TEAMS_TRANSCRIPT_FORMAT,
        });
      }
      let linked = false;
      let analysis: string | null = null;
      if (row.state === 'normalized') {
        await this.screening.linkTranscript({
          tenant_id: auth.tenant_id,
          session_id: session.id,
          conversation_transcript_id: row.id,
          source: 'TEAMS_GRAPH',
          actor_id: auth.sub,
          requestId,
        });
        linked = true;
        // Asynchronous CI screening profile (no model call on this thread);
        // the worker re-checks ai_processing before any model call.
        const scheduled = await this.analysis.scheduleScreening({
          tenant_id: auth.tenant_id,
          conversation_transcript_id: row.id,
          screening_session_id: session.id,
          requisition_id: session.requisition_id,
          request_id: requestId,
        });
        analysis = scheduled.reason;
      }
      items.push({ conversation_transcript_id: row.id, provider_transcript_id: ref.transcript_id, state: row.state, linked, analysis });
    }
    return { items, normalized: items.filter((i) => i.linked) };
  }
}

const ACQUIRABLE = new Set(['source_available', 'failed_retryable', 'intervention_required']);
const NORMALIZABLE = new Set([
  'source_ready',
  'normalizing',
  'normalization_failed_retryable',
  'normalization_intervention_required',
]);

function invalid(requestId: string, field: string): AramoError {
  return new AramoError('VALIDATION_ERROR', `${field} is invalid`, 400, { requestId, details: { invalid_field: field } });
}

function str(v: unknown, field: string, min: number, max: number, requestId: string): string {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw invalid(requestId, field);
  return v;
}

function iso(v: unknown, field: string, requestId: string): string {
  if (typeof v !== 'string' || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw invalid(requestId, field);
  return v;
}
