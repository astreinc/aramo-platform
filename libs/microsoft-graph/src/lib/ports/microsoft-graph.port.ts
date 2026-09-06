// COMM-C2B — Microsoft Graph API port (R8/R13/R15). The concrete adapter calls
// graph.microsoft.com with a delegated access token: `/me` (User.Read),
// `/me/sendMail` (Mail.Send), `/me/onlineMeetings` (OnlineMeetings.ReadWrite).
// It NEVER adds a Talent as a meeting attendee and NEVER reads a mailbox.

export const MICROSOFT_GRAPH_PORT = 'MICROSOFT_GRAPH_PORT';

export interface GraphUserProfile {
  readonly ms_object_id: string;
  readonly ms_tenant_id: string;
  readonly user_principal_name: string;
  readonly display_name: string;
}

export interface GraphSendMailArgs {
  readonly accessToken: string;
  readonly toEmail: string;
  readonly subject: string;
  readonly body: string;
  /** Client-supplied idempotency key (R-idempotency); adapter maps to a safe header. */
  readonly idempotencyKey: string;
}

export interface GraphCreateMeetingArgs {
  readonly accessToken: string;
  readonly subject: string;
  readonly startDateTime: string; // ISO-8601
  readonly endDateTime: string; // ISO-8601
}

export interface GraphMeetingResult {
  readonly provider_meeting_id: string;
  readonly join_url: string;
  readonly start_date_time: string;
  readonly end_date_time: string;
}

export interface MicrosoftGraphPort {
  getMe(accessToken: string): Promise<GraphUserProfile>;
  /** Send-only; resolves on Graph acceptance, rejects on failure (R19). */
  sendMail(args: GraphSendMailArgs): Promise<void>;
  /** Create-link-only: creates the organizer's own meeting; NO attendee invite (R15/R17). */
  createOnlineMeeting(args: GraphCreateMeetingArgs): Promise<GraphMeetingResult>;
}
