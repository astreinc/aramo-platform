// CI-B5Z — the recording-transcript acquisition orchestrator (the durable job
// body). Given a provider-neutral recording-transcript-completed event view
// (already recorded in the CommunicationProviderEvent inbox), it drives the
// canonical flow: correlate → consent(recording ∧ transcription) → B3 register
// → B3 acquire (raw evidence) → B4 normalize. Every step is idempotent and the
// durable state lives in the ConversationTranscript + provider-event rows, so a
// restart/retry re-drives to the same terminal state (no duplicate evidence,
// no duplicate normalization). AI is never invoked here (that is B6).

import type {
  ConversationTranscriptService,
  TranscriptNormalizationService,
} from '@aramo/conversation-transcript';
import { ZOOM_PHONE_PROVIDER_KEY } from '@aramo/communications';

import { ZOOM_RECORDING_TRANSCRIPT_FORMAT } from './zoom-transcript.constants.js';
import type { ZoomRecordingTranscriptEventView } from './zoom-recording-transcript-event.js';

/** Deterministic, tenant-bound correlation of a recording event to ONE interaction. */
export interface TranscriptInteractionCorrelator {
  correlate(input: {
    tenant_id: string;
    integration_connection_id: string;
    call_element_id?: string;
    call_history_id?: string;
    call_id?: string;
  }): Promise<
    | { kind: 'matched'; interaction_id: string }
    | { kind: 'none' }
    | { kind: 'ambiguous' }
  >;
}
export const TRANSCRIPT_INTERACTION_CORRELATOR = 'TRANSCRIPT_INTERACTION_CORRELATOR';

/**
 * The consent gate for CI acquisition. Recording AND transcription must BOTH be
 * authorized (independently — directive §4.2); AI is NOT checked here (B6).
 * Returns a decision reference on ALLOW (provenance, not a scope). Bound at the
 * composition root over the sole Consent authority (libs/consent).
 */
export interface TranscriptConsentGate {
  evaluate(input: {
    tenant_id: string;
    interaction_id: string;
  }): Promise<
    | { allowed: true; consent_decision_ref?: string }
    | { allowed: false; denied_operation: 'recording' | 'transcription' }
    // Talent identity could not be resolved from durable association truth
    // (distinct from a consent denial — never a heuristic guess).
    | { allowed: false; talent_resolution: 'none' | 'ambiguous' }
  >;
}
export const TRANSCRIPT_CONSENT_GATE = 'TRANSCRIPT_CONSENT_GATE';

export type OrchestrationStatus =
  | 'normalized'
  | 'source_ready'
  | 'acquisition_failed'
  | 'parked_no_correlation'
  | 'intervention_ambiguous_correlation'
  | 'parked_no_talent_association'
  | 'intervention_ambiguous_talent'
  | 'consent_denied';

export interface OrchestrationResult {
  readonly status: OrchestrationStatus;
  readonly transcript_id?: string;
  readonly transcript_state?: string;
  readonly detail?: string;
}

export class ZoomRecordingTranscriptOrchestrator {
  constructor(
    private readonly correlator: TranscriptInteractionCorrelator,
    private readonly consent: TranscriptConsentGate,
    private readonly transcripts: ConversationTranscriptService,
    private readonly normalizer: TranscriptNormalizationService,
  ) {}

  async processRecordingTranscriptEvent(input: {
    tenant_id: string;
    integration_connection_id: string;
    view: ZoomRecordingTranscriptEventView;
  }): Promise<OrchestrationResult> {
    const { tenant_id, integration_connection_id, view } = input;

    // 1. Deterministic, tenant-bound correlation (never guess).
    const corr = await this.correlator.correlate({
      tenant_id,
      integration_connection_id,
      call_element_id: view.call_element_id,
      call_history_id: view.call_history_id,
      call_id: view.call_id,
    });
    if (corr.kind === 'none') return { status: 'parked_no_correlation' };
    if (corr.kind === 'ambiguous') return { status: 'intervention_ambiguous_correlation' };
    const interactionId = corr.interaction_id;

    // 2. Talent (durable association) + consent: recording AND transcription
    //    independently required (fail-closed). Talent-resolution failures are
    //    distinct from consent denials (never a heuristic guess — directive).
    const decision = await this.consent.evaluate({ tenant_id, interaction_id: interactionId });
    if (!decision.allowed) {
      if ('talent_resolution' in decision) {
        return {
          status:
            decision.talent_resolution === 'none'
              ? 'parked_no_talent_association'
              : 'intervention_ambiguous_talent',
        };
      }
      return { status: 'consent_denied', detail: decision.denied_operation };
    }

    // 3. B3 register (idempotent) — opens/converges the aggregate and returns
    //    its CURRENT state (a replay returns the existing row unchanged).
    const registered = await this.transcripts.registerTranscriptAvailability({
      tenant_id,
      interaction_id: interactionId,
      provider_key: ZOOM_PHONE_PROVIDER_KEY,
      provider_transcript_id: view.provider_transcript_id,
      provider_resource_ref: view.recording_id,
      source_type: 'provider_full_transcript',
      recording_dependency: 'required',
    });

    // Idempotent short-circuit: an already-normalized transcript is done.
    if (registered.state === 'normalized') {
      return { status: 'normalized', transcript_id: registered.id, transcript_state: registered.state };
    }

    // 4. B3 acquire (idempotent) — UNLESS the source is already ready or we are
    //    already past acquisition (a normalization state). Acquire only from an
    //    acquisition-phase state so a re-drive never re-enters `acquiring` from a
    //    normalized/normalizing state (illegal transition).
    let transcriptId = registered.id;
    if (!NORMALIZE_ENTRY_STATES.has(registered.state)) {
      const acquired = await this.transcripts.acquire({
        tenant_id,
        provider_key: ZOOM_PHONE_PROVIDER_KEY,
        provider_transcript_id: view.provider_transcript_id,
        authorization: {
          transcription_authorized: true,
          consent_decision_ref: decision.consent_decision_ref,
        },
      });
      if (acquired.state !== 'source_ready') {
        return {
          status: 'acquisition_failed',
          transcript_id: acquired.id,
          transcript_state: acquired.state,
          detail: acquired.last_error_code ?? undefined,
        };
      }
      transcriptId = acquired.id;
    }

    // 5. B4 normalize (idempotent) — canonical v1 from the raw Zoom VTT source.
    const normalized = await this.normalizer.normalize({
      tenant_id,
      transcript_id: transcriptId,
      source_format: ZOOM_RECORDING_TRANSCRIPT_FORMAT,
    });
    return {
      status: normalized.state === 'normalized' ? 'normalized' : 'source_ready',
      transcript_id: normalized.id,
      transcript_state: normalized.state,
      detail: normalized.last_error_code ?? undefined,
    };
  }
}

/** States from which the orchestrator proceeds straight to normalization. */
const NORMALIZE_ENTRY_STATES: ReadonlySet<string> = new Set([
  'source_ready',
  'normalizing',
  'normalization_failed_retryable',
  'normalization_intervention_required',
]);
