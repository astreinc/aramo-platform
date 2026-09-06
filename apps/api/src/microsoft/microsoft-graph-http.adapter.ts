import { Injectable } from '@nestjs/common';
import type {
  GraphCreateMeetingArgs,
  GraphMeetingResult,
  GraphSendMailArgs,
  GraphUserProfile,
  MicrosoftGraphPort,
} from '@aramo/microsoft-graph';

// COMM-C2B — Microsoft Graph adapter (R8/R13/R15). Delegated calls only:
//   GET  /me                (User.Read)              — identity for binding
//   POST /me/sendMail       (Mail.Send)              — send AS the signed-in user
//   POST /me/onlineMeetings (OnlineMeetings.ReadWrite) — create-link-only
// It NEVER reads a mailbox and NEVER adds a Talent as a meeting attendee (R17).

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

@Injectable()
export class MicrosoftGraphHttpAdapter implements MicrosoftGraphPort {
  async getMe(accessToken: string): Promise<GraphUserProfile> {
    const res = await fetch(`${GRAPH_BASE}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`graph /me failed: ${String(res.status)}`);
    }
    const json = (await res.json()) as {
      id?: string;
      userPrincipalName?: string;
      displayName?: string;
    };
    return {
      ms_object_id: json.id ?? '',
      ms_tenant_id: '',
      user_principal_name: json.userPrincipalName ?? '',
      display_name: json.displayName ?? '',
    };
  }

  async sendMail(args: GraphSendMailArgs): Promise<void> {
    const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        'content-type': 'application/json',
        // Trace correlation only; true idempotency is enforced at the
        // CommunicationInteraction layer (unique key), not by Graph.
        'client-request-id': args.idempotencyKey,
      },
      body: JSON.stringify({
        message: {
          subject: args.subject,
          body: { contentType: 'Text', content: args.body },
          toRecipients: [{ emailAddress: { address: args.toEmail } }],
        },
        saveToSentItems: true,
      }),
    });
    // Graph returns 202 Accepted on success.
    if (res.status !== 202 && !res.ok) {
      throw new Error(`graph sendMail failed: ${String(res.status)}`);
    }
  }

  async createOnlineMeeting(args: GraphCreateMeetingArgs): Promise<GraphMeetingResult> {
    const res = await fetch(`${GRAPH_BASE}/me/onlineMeetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        'content-type': 'application/json',
      },
      // startDateTime/endDateTime + subject ONLY — no participants/attendees, so
      // Microsoft sends no invite to anyone (create-link-only, R15/R17).
      body: JSON.stringify({
        subject: args.subject,
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
      }),
    });
    if (!res.ok && res.status !== 201) {
      throw new Error(`graph createOnlineMeeting failed: ${String(res.status)}`);
    }
    const json = (await res.json()) as {
      id?: string;
      joinWebUrl?: string;
      joinUrl?: string;
      startDateTime?: string;
      endDateTime?: string;
    };
    return {
      provider_meeting_id: json.id ?? '',
      join_url: json.joinWebUrl ?? json.joinUrl ?? '',
      start_date_time: json.startDateTime ?? args.startDateTime,
      end_date_time: json.endDateTime ?? args.endDateTime,
    };
  }
}
