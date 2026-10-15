import { AramoError } from '@aramo/common';
import {
  ExternalCaptureEventError,
  LiveCaptureSessionBuffer,
  evaluateLiveAssist,
  parseExternalCaptureEvent,
  verifyExternalCaptureSignature,
  type ExternalCaptureProvider,
  type LiveAssistConsent,
} from '@aramo/conversation-transcript';

// TIP-E2E INC-3 A1-6 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §9, §5, C-2, R-C) — the
// composition of the provider-neutral capture contract with the EXISTING
// screening follow-up assistance (suggestFollowUps, TRANSCRIPT_SEGMENTS trigger).
//
// NOT WIRED: no module provides this class, no route or webhook reaches it, and
// no provider is configured. It is exercised only by verification tests against
// the fake provider. Activating any real capture vendor requires the §9 vendor
// gate and a separate production activation (§11).
//
//   - start: transcription + ai_processing (+ recording when the provider
//     records) must ALL be allowed BEFORE the provider joins — else no command
//     is sent at all (fail closed);
//   - ingest: signature + freshness first, then strict parse, tenant/session
//     match, idempotent apply; suggestions only for an admitted, consented feed;
//   - suggestions are advisory, bounded, best-effort: a failure never affects
//     the session or any record;
//   - objection: stop → purge the live window → delete provider artifacts.

export interface LiveAssistConsentPort {
  isOperationAllowed(
    tenantId: string,
    talentRecordId: string,
    operation: 'ai_processing' | 'recording' | 'transcription',
  ): Promise<boolean>;
}

export interface LiveAssistSuggestionPort {
  suggestFollowUps(input: {
    tenant_id: string;
    session_id: string;
    talent_record_id: string;
    actor_id: string;
    trigger: { kind: 'TRANSCRIPT_SEGMENTS'; segment_ids: string[]; text: string };
    plan: string[];
    requestId: string;
  }): Promise<unknown[]>;
}

export interface LiveCaptureHandle {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly talent_record_id: string;
  readonly actor_id: string;
  readonly provider_session_id: string;
  readonly consent: LiveAssistConsent;
  readonly buffer: LiveCaptureSessionBuffer;
  readonly plan: string[];
  finalsSinceSuggestion: number;
}

export type IngestOutcome =
  | { status: 'rejected'; reason: string }
  | { status: 'ignored'; reason: string }
  | { status: 'applied'; suggested: 'yes' | 'no' | 'failed'; assist: string; artifact_ready?: string };

/** Final segments between two suggestion requests (bounded, non-streaming calls). */
export const LIVE_ASSIST_FINALS_PER_REQUEST = 3;
const LIVE_ASSIST_TEXT_MAX = 2000;

export class LiveScreeningAssistCoordinator {
  constructor(
    private readonly provider: ExternalCaptureProvider,
    private readonly signingSecret: string,
    private readonly consent: LiveAssistConsentPort,
    private readonly assist: LiveAssistSuggestionPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async startCapture(input: {
    tenant_id: string;
    session_id: string;
    talent_record_id: string;
    actor_id: string;
    meeting_ref: string;
    join_url: string;
    bot_display_name: string;
    plan: string[];
    requestId: string;
  }): Promise<LiveCaptureHandle> {
    const recordsMedia = this.provider.getCapabilities().recording_dependency === 'required';
    const [transcription, aiProcessing, recording] = await Promise.all([
      this.consent.isOperationAllowed(input.tenant_id, input.talent_record_id, 'transcription'),
      this.consent.isOperationAllowed(input.tenant_id, input.talent_record_id, 'ai_processing'),
      recordsMedia ? this.consent.isOperationAllowed(input.tenant_id, input.talent_record_id, 'recording') : Promise.resolve(false),
    ]);
    const consent: LiveAssistConsent = {
      transcription,
      ai_processing: aiProcessing,
      recording,
      provider_records: recordsMedia,
      confirmed_before_join: true,
    };
    if (!transcription || !aiProcessing || (recordsMedia && !recording)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'live capture requires transcription and AI processing consent', 403, {
        requestId: input.requestId,
        details: { reason: 'capture_consent_missing' },
      });
    }
    const started = await this.provider.start({
      tenant_id: input.tenant_id,
      meeting_ref: input.meeting_ref,
      join_url: input.join_url,
      bot_display_name: input.bot_display_name,
    });
    return {
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      talent_record_id: input.talent_record_id,
      actor_id: input.actor_id,
      provider_session_id: started.provider_session_id,
      consent,
      buffer: new LiveCaptureSessionBuffer(input.tenant_id, started.provider_session_id),
      plan: input.plan,
      finalsSinceSuggestion: 0,
    };
  }

  async ingest(
    handle: LiveCaptureHandle,
    delivery: { rawBody: string; timestamp: string; signature: string },
  ): Promise<IngestOutcome> {
    let event;
    try {
      verifyExternalCaptureSignature({ secret: this.signingSecret, ...delivery, nowMs: this.now() });
      event = parseExternalCaptureEvent(delivery.rawBody);
      const applied = handle.buffer.apply(event);
      if (!applied.applied) return { status: 'ignored', reason: applied.reason };
    } catch (err) {
      if (err instanceof ExternalCaptureEventError) return { status: 'rejected', reason: err.reason };
      throw err;
    }

    const decision = evaluateLiveAssist({ admitted: handle.buffer.admitted, consent: handle.consent });
    const assist = decision.allowed ? 'allowed' : decision.reason;
    if (event.type === 'artifact_ready') {
      return { status: 'applied', suggested: 'no', assist, artifact_ready: event.provider_session_id };
    }
    if (event.type !== 'transcript_segment' || event.payload.kind !== 'final' || !decision.allowed) {
      return { status: 'applied', suggested: 'no', assist };
    }
    handle.finalsSinceSuggestion += 1;
    if (handle.finalsSinceSuggestion < LIVE_ASSIST_FINALS_PER_REQUEST) return { status: 'applied', suggested: 'no', assist };
    handle.finalsSinceSuggestion = 0;

    const window = handle.buffer.finalWindow();
    const text = window.map((s) => s.text).join('\n').slice(-LIVE_ASSIST_TEXT_MAX);
    try {
      await this.assist.suggestFollowUps({
        tenant_id: handle.tenant_id,
        session_id: handle.session_id,
        talent_record_id: handle.talent_record_id,
        actor_id: handle.actor_id,
        trigger: { kind: 'TRANSCRIPT_SEGMENTS', segment_ids: window.map((s) => s.segment_id), text },
        plan: handle.plan,
        requestId: `live-${event.event_id}`,
      });
      return { status: 'applied', suggested: 'yes', assist };
    } catch {
      // Advisory and best-effort: the session and its records are unaffected.
      return { status: 'applied', suggested: 'failed', assist };
    }
  }

  // §5 — a participant objection stops capture and deletes partial data.
  async objection(handle: LiveCaptureHandle): Promise<{ deletion_confirmed: boolean }> {
    await this.provider.stop({ tenant_id: handle.tenant_id, provider_session_id: handle.provider_session_id, reason: 'participant_objection' });
    handle.buffer.purge();
    const deleted = await this.provider.deleteArtifacts({ tenant_id: handle.tenant_id, provider_session_id: handle.provider_session_id });
    return { deletion_confirmed: deleted.confirmed };
  }
}
