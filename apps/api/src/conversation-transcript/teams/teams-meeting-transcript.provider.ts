import type {
  AcquireTranscriptProviderInput,
  ConversationTranscriptProvider,
  ProviderTranscriptReference,
  TranscriptAcquisitionOutcome,
  TranscriptArtifactStore,
  TranscriptCapabilities,
} from '@aramo/conversation-transcript';
import { TranscriptArtifactWriteError } from '@aramo/conversation-transcript';
import { MeetingArtifactError } from '@aramo/microsoft-graph';

import type { MeetingArtifactsService } from '../../microsoft/meeting-artifacts.service.js';

import { MICROSOFT_TEAMS_PROVIDER_KEY } from './teams-transcript.constants.js';

// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D / CI-B5M) — the
// Microsoft Teams post-meeting transcript provider behind the existing B3
// provider-neutral port. provider_resource_ref = "<interaction_id>:<online_meeting_id>".
// The source is fetched with the meeting ORGANIZER's own delegated token (the
// screening route verifies organizer == actor before acquisition) and streamed
// to the encrypted transcript artifact store. Post-meeting only: Teams provides
// no live transcript through this integration (live_transcript_stream: false).

export const TEAMS_ACQUISITION_ERROR_CODES = {
  INVALID_IDENTITY: 'TEAMS_TRANSCRIPT_INVALID_IDENTITY',
  ACCESS_UNAVAILABLE: 'TEAMS_TRANSCRIPT_ACCESS_UNAVAILABLE',
  NOT_FOUND: 'TEAMS_TRANSCRIPT_NOT_FOUND',
  PROVIDER_UNAVAILABLE: 'TEAMS_TRANSCRIPT_PROVIDER_UNAVAILABLE',
  SOURCE_WRITE_FAILED: 'TEAMS_TRANSCRIPT_SOURCE_WRITE_FAILED',
} as const;

export class TeamsMeetingTranscriptProvider implements ConversationTranscriptProvider {
  constructor(
    private readonly artifacts: MeetingArtifactsService,
    private readonly store: TranscriptArtifactStore,
  ) {}

  providerKey(): string {
    return MICROSOFT_TEAMS_PROVIDER_KEY;
  }

  getCapabilities(): TranscriptCapabilities {
    return {
      full_post_conversation_transcript: true,
      live_transcript_stream: false,
      speaker_attribution: true,
      timestamps: true,
      confidence_values: false,
      transcript_language: false,
      custom_vocabulary: false,
      provider_side_redaction: false,
      // Teams transcription is independent of recording (CI v1.2 §4.1).
      recording_dependency: 'not_required',
      provider_transcript_retention: true,
      transcript_availability_event: false,
    };
  }

  resolveTranscriptReference(event: unknown): ProviderTranscriptReference {
    const e = (event ?? {}) as { transcript_id?: unknown; interaction_id?: unknown; online_meeting_id?: unknown };
    if (typeof e.transcript_id !== 'string' || typeof e.interaction_id !== 'string' || typeof e.online_meeting_id !== 'string') {
      throw new Error('unsupported Teams transcript reference');
    }
    return { provider_transcript_id: e.transcript_id, provider_resource_ref: `${e.interaction_id}:${e.online_meeting_id}` };
  }

  async acquireTranscript(input: AcquireTranscriptProviderInput): Promise<TranscriptAcquisitionOutcome> {
    const ref = input.provider_resource_ref ?? '';
    const sep = ref.indexOf(':');
    if (sep <= 0 || sep === ref.length - 1) {
      return { kind: 'terminal_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.INVALID_IDENTITY };
    }
    const interactionId = ref.slice(0, sep);
    const onlineMeetingId = ref.slice(sep + 1);
    let content;
    try {
      content = await this.artifacts.fetchTranscriptContentAsOrganizer({
        tenant_id: input.tenant_id,
        interaction_id: interactionId,
        online_meeting_id: onlineMeetingId,
        transcript_id: input.provider_transcript_id,
      });
    } catch (e) {
      if (e instanceof MeetingArtifactError) {
        if (e.kind === 'throttled' || e.kind === 'transient') {
          return { kind: 'retryable_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.PROVIDER_UNAVAILABLE };
        }
        if (e.kind === 'not_found') return { kind: 'terminal_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.NOT_FOUND };
        return { kind: 'terminal_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.ACCESS_UNAVAILABLE };
      }
      throw e;
    }
    const bytes = Buffer.from(content.body, 'utf8');
    let stored;
    try {
      stored = await this.store.putSource({
        tenant_id: input.tenant_id,
        ref_basis: `${this.providerKey()}/${encodeURIComponent(input.provider_transcript_id)}`,
        bytes,
      });
    } catch (e) {
      if (e instanceof TranscriptArtifactWriteError) {
        return e.retryable
          ? { kind: 'retryable_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.SOURCE_WRITE_FAILED }
          : { kind: 'terminal_failure', error_code: TEAMS_ACQUISITION_ERROR_CODES.SOURCE_WRITE_FAILED };
      }
      throw e;
    }
    return {
      kind: 'acquired',
      result: {
        provider_transcript_id: input.provider_transcript_id,
        source_type: 'provider_full_transcript',
        source_artifact_ref: stored.ref,
        source_sha256: stored.sha256,
        source_byte_length: bytes.byteLength,
        speaker_attribution_supported: content.speaker_attributed,
        timestamps_supported: true,
        recording_dependency: 'not_required',
      },
    };
  }
}
