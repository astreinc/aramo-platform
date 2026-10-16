import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { MeetingSchedulingRepository } from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  MICROSOFT_MEETING_ARTIFACTS_PORT,
  MeetingArtifactError,
  MicrosoftIdentityNotBoundError,
  MicrosoftReauthRequiredError,
  grantsMeetingArtifacts,
  type GraphTranscriptContent,
  type GraphTranscriptRef,
  type MicrosoftMeetingArtifactsPort,
} from '@aramo/microsoft-graph';

import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';
import { MicrosoftProviderNotConfiguredError } from './microsoft-provider-not-configured.error.js';

// TIP-E2E INC-3 A1-4/A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part E/F, §10.1) —
// Teams meeting artifacts for SCREENING meetings, through the existing delegated
// Microsoft integration. Invariants:
//   - DELEGATED only, the ORGANIZER's own token (never another user's — C2B R5
//     no impersonation; never an application permission).
//   - The `meeting_artifacts` capability must actually be GRANTED (the token's
//     granted scope string); otherwise fail closed with an honest status.
//   - Graph transcript APIs are post-meeting only (no live transcript).
//   - Transcript availability is NOT attendance / completion proof (C2B :141-142).

export type MeetingArtifactsCapabilityStatus =
  | 'granted'
  | 'not_granted'
  | 'not_connected'
  | 'reauth_required';

export interface PreparedMeetingArtifacts {
  status: 'prepared' | 'not_granted' | 'meeting_not_resolved' | 'provider_error';
  // recordAutomatically is set ONLY when `recording` consent allows it (A1 §5).
  record_automatically: boolean;
}


@Injectable()
export class MeetingArtifactsService {
  private readonly logger = new Logger(MeetingArtifactsService.name);

  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    private readonly config: MicrosoftConfigResolver,
    private readonly repo: MeetingSchedulingRepository,
    @Inject(MICROSOFT_MEETING_ARTIFACTS_PORT) private readonly artifacts: MicrosoftMeetingArtifactsPort,
  ) {}

  private async token(tenantId: string, recruiterId: string): Promise<{ access_token: string; granted_scope: string }> {
    const connectionId = await this.config.resolveConnectionId(tenantId, undefined);
    const cfg = await this.config.resolveConfig(tenantId, connectionId, true);
    const t = await this.delegated.getUsableAccessToken({
      tenant_id: tenantId,
      connection_id: connectionId,
      recruiter_id: recruiterId,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      authorityTenant: cfg.authorityTenant,
      nowEpochSeconds: this.config.nowSeconds(),
    });
    return { access_token: t.access_token, granted_scope: t.granted_scope ?? '' };
  }

  // Honest capability status for the screening capture-mode display.
  async capabilityStatus(tenantId: string, recruiterId: string): Promise<MeetingArtifactsCapabilityStatus> {
    try {
      const t = await this.token(tenantId, recruiterId);
      return grantsMeetingArtifacts(t.granted_scope) ? 'granted' : 'not_granted';
    } catch (err) {
      if (err instanceof MicrosoftReauthRequiredError) return 'reauth_required';
      if (err instanceof MicrosoftIdentityNotBoundError || err instanceof MicrosoftProviderNotConfiguredError) {
        return 'not_connected';
      }
      return 'not_connected';
    }
  }

  // Best-effort preparation right after a screening meeting is scheduled:
  // resolve the onlineMeeting id from the join URL, store it on the meeting
  // interaction, and set recordAutomatically before the meeting starts. A
  // failure here never fails the scheduled meeting; it is reported honestly.
  async prepareScreeningMeeting(args: {
    tenant_id: string;
    organizer_id: string;
    interaction_id: string;
    recording_allowed: boolean;
  }): Promise<PreparedMeetingArtifacts> {
    let recorded = false;
    try {
      const t = await this.token(args.tenant_id, args.organizer_id);
      if (!grantsMeetingArtifacts(t.granted_scope)) return { status: 'not_granted', record_automatically: false };
      const meeting = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
      if (meeting === null || meeting.join_reference === null) {
        return { status: 'meeting_not_resolved', record_automatically: false };
      }
      const ref = await this.artifacts.findOnlineMeetingByJoinUrl({ accessToken: t.access_token, joinUrl: meeting.join_reference });
      if (ref === null) return { status: 'meeting_not_resolved', record_automatically: false };
      await this.repo.setOnlineMeetingId(args.tenant_id, args.interaction_id, ref.online_meeting_id);
      if (args.recording_allowed) {
        await this.artifacts.setRecordAutomatically({ accessToken: t.access_token, onlineMeetingId: ref.online_meeting_id });
        recorded = true;
      }
      return { status: 'prepared', record_automatically: recorded };
    } catch (err) {
      this.logger.warn(
        `screening meeting artifact preparation failed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
      return { status: 'provider_error', record_automatically: recorded };
    }
  }

  // The organizer (initiating recruiter) of a scheduled meeting interaction.
  async organizerOf(tenantId: string, interactionId: string): Promise<string | null> {
    const meeting = await this.repo.findScheduledMeeting(tenantId, interactionId);
    return meeting?.initiated_by_id ?? null;
  }

  // Post-meeting transcript LISTING for a screening meeting (organizer only,
  // capability-gated). Polling is the documented fallback when no change-
  // notification subscription exists. Content is fetched by the B3 Teams
  // provider adapter through fetchTranscriptContentAsOrganizer.
  async listTranscriptRefs(args: {
    tenant_id: string;
    organizer_id: string;
    acting_recruiter_id: string;
    interaction_id: string;
    requestId: string;
  }): Promise<{ online_meeting_id: string; transcripts: GraphTranscriptRef[] }> {
    if (args.acting_recruiter_id !== args.organizer_id) {
      throw new AramoError(
        'MICROSOFT_MEETING_NOT_ORGANIZER',
        'only the organizing recruiter may retrieve this meeting transcript',
        403,
        { requestId: args.requestId },
      );
    }
    const t = await this.organizerToken(args.tenant_id, args.organizer_id, args.requestId);
    try {
      let onlineMeetingId = await this.repo.findOnlineMeetingId(args.tenant_id, args.interaction_id);
      if (onlineMeetingId === null) {
        const meeting = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
        if (meeting === null || meeting.join_reference === null) {
          throw new AramoError('MICROSOFT_MEETING_NOT_FOUND', 'scheduling meeting not found', 404, { requestId: args.requestId });
        }
        const ref = await this.artifacts.findOnlineMeetingByJoinUrl({ accessToken: t.access_token, joinUrl: meeting.join_reference });
        if (ref === null) {
          throw new AramoError('MICROSOFT_MEETING_NOT_FOUND', 'online meeting not found', 404, { requestId: args.requestId });
        }
        onlineMeetingId = ref.online_meeting_id;
        await this.repo.setOnlineMeetingId(args.tenant_id, args.interaction_id, onlineMeetingId);
      }
      const transcripts = await this.artifacts.listTranscripts({ accessToken: t.access_token, onlineMeetingId });
      return { online_meeting_id: onlineMeetingId, transcripts };
    } catch (err) {
      throw this.mapArtifactError(err, args.requestId);
    }
  }

  // Used ONLY by the B3 Teams provider adapter during an acquisition that the
  // organizer just initiated (the screening route enforces organizer == actor
  // before acquisition). Resolves the organizer from the meeting interaction and
  // uses that organizer's own delegated token.
  async fetchTranscriptContentAsOrganizer(args: {
    tenant_id: string;
    interaction_id: string;
    online_meeting_id: string;
    transcript_id: string;
  }): Promise<GraphTranscriptContent> {
    const meeting = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
    if (meeting === null || meeting.initiated_by_id === null) {
      throw new MeetingArtifactError('not_found', 404, 'screening meeting not found');
    }
    const t = await this.token(args.tenant_id, meeting.initiated_by_id);
    if (!grantsMeetingArtifacts(t.granted_scope)) {
      throw new MeetingArtifactError('forbidden', 403, 'meeting_artifacts capability not granted');
    }
    return this.artifacts.getTranscriptContent({
      accessToken: t.access_token,
      onlineMeetingId: args.online_meeting_id,
      transcriptId: args.transcript_id,
    });
  }

  private async organizerToken(
    tenantId: string,
    organizerId: string,
    requestId: string,
  ): Promise<{ access_token: string; granted_scope: string }> {
    let t: { access_token: string; granted_scope: string };
    try {
      t = await this.token(tenantId, organizerId);
    } catch (err) {
      if (err instanceof MicrosoftReauthRequiredError || err instanceof MicrosoftIdentityNotBoundError) {
        throw new AramoError('MICROSOFT_REAUTHORIZATION_REQUIRED', 'microsoft identity requires (re)authorization', 409, {
          requestId,
        });
      }
      if (err instanceof MicrosoftProviderNotConfiguredError) {
        throw new AramoError('MICROSOFT_PROVIDER_NOT_CONFIGURED', err.message, 409, { requestId });
      }
      throw err;
    }
    if (!grantsMeetingArtifacts(t.granted_scope)) throw this.unavailable(requestId, 'meeting_artifacts_not_granted');
    return t;
  }

  private mapArtifactError(err: unknown, requestId: string): unknown {
    if (!(err instanceof MeetingArtifactError)) return err;
    if (err.kind === 'transcripts_disabled') return this.unavailable(requestId, 'graph_transcript_access_disabled');
    if (err.kind === 'forbidden') return this.unavailable(requestId, 'admin_consent_or_scope_missing');
    if (err.kind === 'reauth_required') {
      return new AramoError('MICROSOFT_REAUTHORIZATION_REQUIRED', 'microsoft identity requires (re)authorization', 409, {
        requestId,
      });
    }
    if (err.kind === 'not_found') {
      return new AramoError('MICROSOFT_MEETING_NOT_FOUND', 'online meeting not found', 404, { requestId });
    }
    return new AramoError('MICROSOFT_PROVIDER_ERROR', 'microsoft meeting artifact provider error', 502, { requestId });
  }

  private unavailable(requestId: string, reason: string): AramoError {
    return new AramoError(
      'MEETING_ARTIFACT_ACCESS_UNAVAILABLE',
      'Teams meeting transcripts are not available for this tenant (see the Microsoft 365 prerequisites)',
      409,
      { requestId, details: { reason } },
    );
  }
}
