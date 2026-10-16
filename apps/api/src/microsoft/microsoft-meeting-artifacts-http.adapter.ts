import {
  MeetingArtifactError,
  type GraphOnlineMeetingRef,
  type GraphTranscriptContent,
  type GraphTranscriptRef,
  type MicrosoftMeetingArtifactsPort,
} from '@aramo/microsoft-graph';

// TIP-E2E INC-3 A1 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part E) — the delegated
// Microsoft Graph meeting-artifact adapter. Validated against
// learn.microsoft.com (2026-10-15): transcript APIs are post-meeting only and
// support calendar-event meetings; delegated OnlineMeetingTranscript.Read.All
// needs tenant admin consent; tenant "Transcript API access" defaults OFF
// (403 GraphAccessToTranscriptsDisabled); speaker attribution defaults OFF
// (403 SpeakerAttributionNotAllowed → retry the unattributed format, selectable
// only through the Accept header). The organizer's own delegated token only.
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const VTT = 'text/vtt';
const UNATTRIBUTED = 'application/vnd.microsoft.graph.transcript+text';

// Graph carries these specific reasons in error.innerError.code (error.code is
// the generic "Forbidden"); read the inner code first, the outer as fallback.
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown; innerError?: { code?: unknown } } };
    const inner = body.error?.innerError?.code;
    if (typeof inner === 'string') return inner;
    return typeof body.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

async function classify(res: Response, what: string): Promise<MeetingArtifactError> {
  const code = await errorCode(res);
  if (res.status === 403 && code === 'GraphAccessToTranscriptsDisabled') {
    return new MeetingArtifactError('transcripts_disabled', 403, `${what}: tenant transcript API access is disabled`);
  }
  if (res.status === 401) return new MeetingArtifactError('reauth_required', 401, `${what}: reauthorization required`);
  if (res.status === 403) return new MeetingArtifactError('forbidden', 403, `${what}: forbidden (admin consent or scope missing)`);
  if (res.status === 404) return new MeetingArtifactError('not_found', 404, `${what}: not found`);
  if (res.status === 429) return new MeetingArtifactError('throttled', 429, `${what}: throttled`);
  if (res.status >= 500) return new MeetingArtifactError('transient', res.status, `${what}: provider unavailable`);
  return new MeetingArtifactError('permanent', res.status, `${what}: rejected`);
}

export class MicrosoftMeetingArtifactsHttpAdapter implements MicrosoftMeetingArtifactsPort {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async get(url: string, accessToken: string, accept?: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, ...(accept !== undefined ? { accept } : {}) },
      });
    } catch {
      throw new MeetingArtifactError('transient', 0, 'network error contacting Microsoft Graph');
    }
  }

  async findOnlineMeetingByJoinUrl(args: { accessToken: string; joinUrl: string }): Promise<GraphOnlineMeetingRef | null> {
    // The joinWebUrl must be URL-encoded inside the $filter literal (Graph doc).
    const filter = `JoinWebUrl eq '${args.joinUrl.replace(/'/g, "''")}'`;
    const res = await this.get(`${GRAPH_BASE}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`, args.accessToken);
    if (!res.ok) throw await classify(res, 'resolve online meeting');
    const body = (await res.json()) as { value?: Array<{ id?: unknown }> };
    const id = body.value?.[0]?.id;
    return typeof id === 'string' && id.length > 0 ? { online_meeting_id: id } : null;
  }

  async setRecordAutomatically(args: { accessToken: string; onlineMeetingId: string }): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(args.onlineMeetingId)}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${args.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ recordAutomatically: true }),
      });
    } catch {
      throw new MeetingArtifactError('transient', 0, 'network error contacting Microsoft Graph');
    }
    if (!res.ok) throw await classify(res, 'set recordAutomatically');
  }

  async listTranscripts(args: { accessToken: string; onlineMeetingId: string }): Promise<GraphTranscriptRef[]> {
    const res = await this.get(
      `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(args.onlineMeetingId)}/transcripts`,
      args.accessToken,
    );
    if (!res.ok) throw await classify(res, 'list transcripts');
    const body = (await res.json()) as { value?: Array<{ id?: unknown; createdDateTime?: unknown }> };
    return (body.value ?? [])
      .filter((t): t is { id: string; createdDateTime?: unknown } => typeof t.id === 'string')
      .map((t) => ({
        transcript_id: t.id,
        created_date_time: typeof t.createdDateTime === 'string' ? t.createdDateTime : null,
      }));
  }

  async getTranscriptContent(args: {
    accessToken: string;
    onlineMeetingId: string;
    transcriptId: string;
  }): Promise<GraphTranscriptContent> {
    const url = `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(args.onlineMeetingId)}/transcripts/${encodeURIComponent(args.transcriptId)}/content`;
    const res = await this.get(url, args.accessToken, VTT);
    if (res.ok) return { body: await res.text(), content_type: VTT, speaker_attributed: true };
    if (res.status === 403 && (await errorCode(res)) === 'SpeakerAttributionNotAllowed') {
      const plain = await this.get(url, args.accessToken, UNATTRIBUTED);
      if (!plain.ok) throw await classify(plain, 'get transcript content');
      return { body: await plain.text(), content_type: UNATTRIBUTED, speaker_attributed: false };
    }
    throw await classify(res, 'get transcript content');
  }
}
