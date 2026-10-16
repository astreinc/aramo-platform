import { createHash, randomUUID } from 'node:crypto';

import type {
  AcquireTranscriptProviderInput,
  ProviderTranscriptReference,
  TranscriptAcquisitionOutcome,
  TranscriptCapabilities,
} from '../provider/conversation-transcript-provider.port.js';

import {
  signExternalCaptureEvent,
  type ExternalCaptureEvent,
  type ExternalCaptureProvider,
} from './external-capture.contract.js';

// TIP-E2E INC-3 A1-6 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §9, R-C) — a FAKE
// external capture provider for verification tests ONLY. It is not registered
// in any provider registry, module, route or queue, and it never contacts a
// network. It exists to prove the provider-neutral contract (signed, idempotent
// events; start/stop/delete commands; post-meeting artifact via the B3 port).
// No real vendor is connected or represented as operational.

export const FAKE_EXTERNAL_CAPTURE_PROVIDER_KEY = 'fake_external_capture';

export class FakeExternalCaptureProvider implements ExternalCaptureProvider {
  readonly commands: Array<{ kind: 'start' | 'stop' | 'delete'; provider_session_id: string; reason?: string }> = [];
  private readonly artifacts = new Map<string, string>();
  private deletedSessions = new Set<string>();

  constructor(
    private readonly secret: string,
    private readonly opts: { records_media?: boolean; delete_confirms?: boolean } = {},
  ) {}

  providerKey(): string {
    return FAKE_EXTERNAL_CAPTURE_PROVIDER_KEY;
  }

  getCapabilities(): TranscriptCapabilities {
    return {
      full_post_conversation_transcript: true,
      live_transcript_stream: true,
      speaker_attribution: true,
      timestamps: true,
      confidence_values: false,
      transcript_language: false,
      custom_vocabulary: false,
      provider_side_redaction: false,
      recording_dependency: this.opts.records_media === true ? 'required' : 'not_required',
      provider_transcript_retention: true,
      transcript_availability_event: true,
    };
  }

  resolveTranscriptReference(event: unknown): ProviderTranscriptReference {
    const e = event as Partial<ExternalCaptureEvent>;
    if (e?.type !== 'artifact_ready' || typeof e.provider_session_id !== 'string') {
      throw new Error('unsupported capture reference');
    }
    return { provider_transcript_id: e.provider_session_id };
  }

  async acquireTranscript(input: AcquireTranscriptProviderInput): Promise<TranscriptAcquisitionOutcome> {
    const body = this.artifacts.get(input.provider_transcript_id);
    if (body === undefined || this.deletedSessions.has(input.provider_transcript_id)) {
      return { kind: 'terminal_failure', error_code: 'FAKE_CAPTURE_ARTIFACT_NOT_FOUND' };
    }
    return {
      kind: 'acquired',
      result: {
        provider_transcript_id: input.provider_transcript_id,
        source_type: 'provider_full_transcript',
        source_artifact_ref: `fake://${input.tenant_id}/${input.provider_transcript_id}`,
        source_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        source_byte_length: Buffer.byteLength(body, 'utf8'),
        speaker_attribution_supported: true,
        timestamps_supported: true,
        recording_dependency: this.opts.records_media === true ? 'required' : 'not_required',
      },
    };
  }

  async start(): Promise<{ provider_session_id: string }> {
    const provider_session_id = `fake-session-${randomUUID()}`;
    this.commands.push({ kind: 'start', provider_session_id });
    return { provider_session_id };
  }

  async stop(input: { provider_session_id: string; reason: string }): Promise<void> {
    this.commands.push({ kind: 'stop', provider_session_id: input.provider_session_id, reason: input.reason });
  }

  async deleteArtifacts(input: { provider_session_id: string }): Promise<{ confirmed: boolean }> {
    this.commands.push({ kind: 'delete', provider_session_id: input.provider_session_id });
    this.deletedSessions.add(input.provider_session_id);
    this.artifacts.delete(input.provider_session_id);
    return { confirmed: this.opts.delete_confirms !== false };
  }

  /** Test helper: stage the post-meeting transcript body for a session. */
  stageArtifact(providerSessionId: string, body: string): void {
    this.artifacts.set(providerSessionId, body);
  }

  /** Test helper: a signed delivery exactly as a provider webhook would send it. */
  deliver(event: ExternalCaptureEvent, nowMs: number): { rawBody: string; timestamp: string; signature: string } {
    const rawBody = JSON.stringify(event);
    const timestamp = String(nowMs);
    return { rawBody, timestamp, signature: signExternalCaptureEvent(this.secret, timestamp, rawBody) };
  }
}
