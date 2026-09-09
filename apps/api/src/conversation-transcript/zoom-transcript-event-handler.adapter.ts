// CI-B5Z — binds the webhook's ZoomTranscriptEventHandler port to the CI
// orchestrator. Parses the (already signature-verified) raw body for the Zoom
// recording identity, merges the TRUSTED envelope correlation ids, and drives
// the idempotent orchestration. Maps park/retryable outcomes to `retriable` so
// the webhook keeps the inbox row re-drivable.

import { Injectable } from '@nestjs/common';

import type {
  ZoomTranscriptEventHandler,
  ZoomTranscriptEventHandlerInput,
} from '../communications/zoom-transcript-event-handler.port.js';

import { parseZoomRecordingTranscriptEvent } from './zoom/zoom-recording-transcript-event.js';
import { ZoomRecordingTranscriptOrchestrator } from './zoom/zoom-recording-transcript.orchestrator.js';

@Injectable()
export class ZoomTranscriptEventHandlerAdapter implements ZoomTranscriptEventHandler {
  constructor(private readonly orchestrator: ZoomRecordingTranscriptOrchestrator) {}

  async handle(input: ZoomTranscriptEventHandlerInput): Promise<{ retriable: boolean }> {
    let body: unknown;
    try {
      body = JSON.parse(input.raw_body);
    } catch {
      return { retriable: false }; // malformed body → terminal, not re-drivable
    }
    const parsed = parseZoomRecordingTranscriptEvent(body);
    if (parsed === null) return { retriable: false };

    const result = await this.orchestrator.processRecordingTranscriptEvent({
      tenant_id: input.tenant_id,
      integration_connection_id: input.integration_connection_id,
      view: {
        recording_id: parsed.recording_id,
        provider_transcript_id: parsed.provider_transcript_id,
        // Prefer the TRUSTED (post-HMAC) envelope correlation ids.
        call_id: input.correlation.call_id ?? parsed.call_id,
        call_history_id: input.correlation.call_history_uuid ?? parsed.call_history_id,
        call_element_id: input.correlation.call_element_id ?? parsed.call_element_id,
      },
    });

    const retriable =
      result.status === 'parked_no_correlation' ||
      result.status === 'parked_no_talent_association' ||
      result.status === 'acquisition_failed';
    return { retriable };
  }
}
