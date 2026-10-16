// TIP-E2E INC-3 A1 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part E, §10.1) — the
// DELEGATED Microsoft Graph meeting-artifact operations for screening meetings.
// Post-meeting only: Graph transcript APIs serve a transcript after the meeting
// ends, for meetings created as calendar events (the scheduling path). Every
// call uses the organizer's own delegated token — never an application
// permission, never another user's token.

export const MICROSOFT_MEETING_ARTIFACTS_PORT = 'MICROSOFT_MEETING_ARTIFACTS_PORT';

export interface GraphOnlineMeetingRef {
  /** The onlineMeeting id resolved from the calendar event's join URL. */
  readonly online_meeting_id: string;
}

export interface GraphTranscriptRef {
  readonly transcript_id: string;
  readonly created_date_time: string | null;
}

export interface GraphTranscriptContent {
  readonly body: string;
  /** `text/vtt` (speaker-attributed) or the unattributed
   *  `application/vnd.microsoft.graph.transcript+text` fallback. */
  readonly content_type: 'text/vtt' | 'application/vnd.microsoft.graph.transcript+text';
  readonly speaker_attributed: boolean;
}

/**
 * Typed meeting-artifact failures. `transcripts_disabled` is Microsoft's
 * 403 GraphAccessToTranscriptsDisabled (tenant Transcript API access is off —
 * the default); `forbidden` covers a missing admin consent / scope.
 */
export type MeetingArtifactErrorKind =
  | 'transcripts_disabled'
  | 'forbidden'
  | 'not_found'
  | 'reauth_required'
  | 'throttled'
  | 'transient'
  | 'permanent';

export class MeetingArtifactError extends Error {
  constructor(
    readonly kind: MeetingArtifactErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MeetingArtifactError';
  }
}

export interface MicrosoftMeetingArtifactsPort {
  /** GET /me/onlineMeetings?$filter=JoinWebUrl eq '{joinUrl}' (delegated OnlineMeetings.Read[Write]). */
  findOnlineMeetingByJoinUrl(args: { accessToken: string; joinUrl: string }): Promise<GraphOnlineMeetingRef | null>;
  /** PATCH /me/onlineMeetings/{id} { recordAutomatically: true } — before the meeting starts. */
  setRecordAutomatically(args: { accessToken: string; onlineMeetingId: string }): Promise<void>;
  /** GET /me/onlineMeetings/{id}/transcripts (delegated OnlineMeetingTranscript.Read.All). */
  listTranscripts(args: { accessToken: string; onlineMeetingId: string }): Promise<GraphTranscriptRef[]>;
  /** GET .../transcripts/{tid}/content — text/vtt, falling back to the unattributed
   *  format when speaker attribution is not allowed (403 SpeakerAttributionNotAllowed). */
  getTranscriptContent(args: {
    accessToken: string;
    onlineMeetingId: string;
    transcriptId: string;
  }): Promise<GraphTranscriptContent>;
}
