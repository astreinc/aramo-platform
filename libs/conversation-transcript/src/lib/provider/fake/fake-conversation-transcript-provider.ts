// CI-B3 — the ONLY provider adapter in B3: a provider-neutral test FAKE (no
// vendor vocabulary, no network, no real provider call — directive §30.9/§15).
// It exists to exercise the acquisition port/service contract deterministically.
// It NEVER emits a transcript body: it returns an opaque source_artifact_ref +
// synthetic hash, exactly like a real adapter that streamed content to object
// storage.

import type {
  AcquireTranscriptProviderInput,
  ConversationTranscriptProvider,
  ProviderTranscriptReference,
  TranscriptAcquisitionOutcome,
  TranscriptCapabilities,
} from '../conversation-transcript-provider.port.js';

export const FAKE_TRANSCRIPT_PROVIDER_KEY = 'fake_transcript';

/** Deterministic behaviour selector for the fake. */
export type FakeAcquisitionMode = 'acquired' | 'retryable' | 'terminal';

export interface FakeTranscriptProviderOptions {
  readonly mode?: FakeAcquisitionMode;
  readonly capabilities?: Partial<TranscriptCapabilities>;
  /** Fixed source artifact ref returned on `acquired` (idempotency proof). */
  readonly sourceArtifactRef?: string;
  readonly sourceSha256?: string;
  readonly language?: string;
}

const DEFAULT_CAPABILITIES: TranscriptCapabilities = {
  full_post_conversation_transcript: true,
  live_transcript_stream: false,
  speaker_attribution: true,
  timestamps: true,
  confidence_values: false,
  transcript_language: true,
  custom_vocabulary: false,
  provider_side_redaction: false,
  // Provider-DECLARED: the fake declares `unknown` — B3 asserts nothing about
  // any real provider's recording dependency (directive §30.20).
  recording_dependency: 'unknown',
  provider_transcript_retention: true,
  transcript_availability_event: true,
};

export class FakeConversationTranscriptProvider
  implements ConversationTranscriptProvider
{
  private readonly opts: FakeTranscriptProviderOptions;
  /** Records acquire() invocations for idempotency assertions. */
  public acquireCallCount = 0;

  constructor(opts: FakeTranscriptProviderOptions = {}) {
    this.opts = opts;
  }

  providerKey(): string {
    return FAKE_TRANSCRIPT_PROVIDER_KEY;
  }

  getCapabilities(): TranscriptCapabilities {
    return { ...DEFAULT_CAPABILITIES, ...this.opts.capabilities };
  }

  resolveTranscriptReference(event: unknown): ProviderTranscriptReference {
    // Provider-neutral synthetic event shape — NOT a vendor webhook payload.
    const e = (event ?? {}) as {
      provider_transcript_id?: string;
      provider_resource_ref?: string;
    };
    if (typeof e.provider_transcript_id !== 'string' || e.provider_transcript_id.length === 0) {
      throw new Error('fake event missing provider_transcript_id');
    }
    return {
      provider_transcript_id: e.provider_transcript_id,
      provider_resource_ref: e.provider_resource_ref,
    };
  }

  async acquireTranscript(
    input: AcquireTranscriptProviderInput,
  ): Promise<TranscriptAcquisitionOutcome> {
    this.acquireCallCount += 1;
    const mode = this.opts.mode ?? 'acquired';
    if (mode === 'retryable') {
      return { kind: 'retryable_failure', error_code: 'PROVIDER_TEMPORARY' };
    }
    if (mode === 'terminal') {
      return { kind: 'terminal_failure', error_code: 'PROVIDER_GONE' };
    }
    return {
      kind: 'acquired',
      result: {
        provider_transcript_id: input.provider_transcript_id,
        source_type: 'provider_full_transcript',
        // Deterministic opaque handle — the same input yields the same ref, so
        // repeated acquisition converges (no duplicate artifact metadata).
        source_artifact_ref:
          this.opts.sourceArtifactRef ??
          `conversation-transcript/${input.tenant_id}/${input.provider_key}/${input.provider_transcript_id}/source`,
        source_sha256:
          this.opts.sourceSha256 ??
          'a'.repeat(64),
        source_byte_length: 1024,
        language: this.opts.language ?? 'en-US',
        speaker_attribution_supported: true,
        timestamps_supported: true,
        recording_dependency: 'unknown',
      },
    };
  }
}
