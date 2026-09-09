// CI-B5Z — the Zoom Phone recording-transcript adapter implementing the B3
// provider-neutral ConversationTranscriptProvider. It translates the officially
// supported AD_HOC_RECORDING_TRANSCRIPT route into the B3 contract: fetch the
// FULL Zoom transcript, preserve it as raw encrypted evidence (putSource), and
// return an opaque handle + hash. No Zoom vocabulary crosses the B3 boundary
// (the result is provider-neutral). No AI summary is ever accepted; no audio is
// touched.

import type {
  AcquireTranscriptProviderInput,
  ConversationTranscriptProvider,
  ProviderTranscriptReference,
  TranscriptAcquisitionOutcome,
  TranscriptArtifactStore,
  TranscriptCapabilities,
} from '@aramo/conversation-transcript';
import { TranscriptArtifactWriteError } from '@aramo/conversation-transcript';
import { ZOOM_PHONE_PROVIDER_KEY } from '@aramo/communications';

import { parseZoomRecordingTranscriptEvent } from './zoom-recording-transcript-event.js';
import {
  ZoomTranscriptFetchError,
  type ZoomTranscriptHttpClient,
} from './zoom-transcript-http.client.js';

/** Resolves the tenant's Zoom Phone IntegrationConnection secret_ref (composition-bound). */
export interface ZoomConnectionSecretResolver {
  /**
   * Resolve the (single) active zoom_phone connection secret_ref for a tenant.
   * Throws {@link ZoomConnectionResolutionError} when absent (terminal) or the
   * lookup transiently fails (retryable).
   */
  resolveSecretRef(tenantId: string): Promise<string>;
}

export class ZoomConnectionResolutionError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  constructor(code: string, retryable: boolean) {
    super(`zoom connection resolution failed: ${code}`);
    this.name = 'ZoomConnectionResolutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Safe acquisition error codes (never carry transcript body / token / URL). */
export const ZOOM_ACQUISITION_ERROR_CODES = {
  INVALID_IDENTITY: 'ZOOM_TRANSCRIPT_INVALID_IDENTITY',
  NOT_A_TRANSCRIPT: 'ZOOM_TRANSCRIPT_NOT_A_TRANSCRIPT',
  SOURCE_WRITE_FAILED: 'ZOOM_TRANSCRIPT_SOURCE_WRITE_FAILED',
} as const;

export class ZoomRecordingTranscriptProvider implements ConversationTranscriptProvider {
  constructor(
    private readonly client: ZoomTranscriptHttpClient,
    private readonly store: TranscriptArtifactStore,
    private readonly connections: ZoomConnectionSecretResolver,
  ) {}

  providerKey(): string {
    return ZOOM_PHONE_PROVIDER_KEY; // 'zoom_phone'
  }

  /**
   * Capability declaration for the IMPLEMENTED path (AD_HOC_RECORDING_TRANSCRIPT).
   * recording_dependency = 'required' is a PER-PATH fact — Aramo has no proven
   * API for Zoom's native no-recording transcript (CI-B5Z-0 ruling). This is NOT
   * a product-wide invariant.
   */
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
      recording_dependency: 'required',
      provider_transcript_retention: true,
      transcript_availability_event: true,
    };
  }

  resolveTranscriptReference(event: unknown): ProviderTranscriptReference {
    const view = parseZoomRecordingTranscriptEvent(event);
    if (view === null) {
      throw new Error('unsupported zoom recording-transcript event');
    }
    return {
      provider_transcript_id: view.provider_transcript_id,
      // provider_resource_ref = the stable Zoom recording id (endpoint key).
      // NOT the ephemeral download_url (never persisted).
      provider_resource_ref: view.recording_id,
    };
  }

  async acquireTranscript(
    input: AcquireTranscriptProviderInput,
  ): Promise<TranscriptAcquisitionOutcome> {
    const recordingId = input.provider_resource_ref;
    if (recordingId === undefined || recordingId.length === 0) {
      return { kind: 'terminal_failure', error_code: ZOOM_ACQUISITION_ERROR_CODES.INVALID_IDENTITY };
    }

    let secretRef: string;
    try {
      secretRef = await this.connections.resolveSecretRef(input.tenant_id);
    } catch (e) {
      if (e instanceof ZoomConnectionResolutionError) {
        return e.retryable
          ? { kind: 'retryable_failure', error_code: e.code }
          : { kind: 'terminal_failure', error_code: e.code };
      }
      throw e;
    }

    let downloaded;
    try {
      downloaded = await this.client.downloadRecordingTranscript({
        tenantSecretRef: secretRef,
        recordingId,
      });
    } catch (e) {
      if (e instanceof ZoomTranscriptFetchError) {
        return e.retryable
          ? { kind: 'retryable_failure', error_code: e.code }
          : { kind: 'terminal_failure', error_code: e.code };
      }
      throw e;
    }

    // Full transcript only: reject an AI summary / non-VTT object at the boundary
    // (a summary is NEVER a valid transcript). WEBVTT bodies begin "WEBVTT".
    const head = downloaded.bytes.subarray(0, 16).toString('utf8').replace(/^\uFEFF/, '');
    if (!/^WEBVTT(?:\s|$)/.test(head)) {
      return { kind: 'terminal_failure', error_code: ZOOM_ACQUISITION_ERROR_CODES.NOT_A_TRANSCRIPT };
    }

    // Preserve the raw transcript as durable encrypted evidence (source artifact).
    let stored;
    try {
      stored = await this.store.putSource({
        tenant_id: input.tenant_id,
        ref_basis: `${this.providerKey()}/${encodeURIComponent(input.provider_transcript_id)}`,
        bytes: downloaded.bytes,
      });
    } catch (e) {
      if (e instanceof TranscriptArtifactWriteError) {
        return e.retryable
          ? { kind: 'retryable_failure', error_code: ZOOM_ACQUISITION_ERROR_CODES.SOURCE_WRITE_FAILED }
          : { kind: 'terminal_failure', error_code: ZOOM_ACQUISITION_ERROR_CODES.SOURCE_WRITE_FAILED };
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
        source_byte_length: downloaded.bytes.byteLength,
        speaker_attribution_supported: true,
        timestamps_supported: true,
        recording_dependency: 'required',
      },
    };
  }
}
