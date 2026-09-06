import { Inject, Injectable } from '@nestjs/common';
import { CommunicationsRepository } from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  MICROSOFT_GRAPH_PORT,
  type MicrosoftGraphPort,
} from '@aramo/microsoft-graph';

import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';

// COMM-C2B — Teams meeting creation, CREATE-LINK-ONLY (Architect R17 ruling +
// R15/R16). Uses the bound recruiter's delegated identity (OnlineMeetings.ReadWrite
// only) to create the organizer's own online meeting. It NEVER adds the Talent as
// a Graph attendee and sends NO invitation — meeting creation is therefore not a
// Talent-contact event and needs no consent gate. It persists a provider-neutral
// CommunicationInteraction (channel=meeting) with the join reference + scheduled
// window + Talent×Requisition(+Pipeline) association. It mutates NO Pipeline /
// Client / Interview state and treats the meeting as neither attendance nor
// completion. If the recruiter wants the Talent to receive the link, that goes
// through the consent-gated email path separately.

export interface CreateRecruiterMeetingArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly connection_id?: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  readonly subject: string;
  readonly start_date_time: string; // ISO-8601
  readonly end_date_time: string; // ISO-8601
  readonly idempotency_key: string;
}

export interface MeetingResultView {
  readonly interaction_id: string;
  readonly join_url: string;
  readonly scheduled_start: string;
  readonly scheduled_end: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly idempotent_replay: boolean;
}

@Injectable()
export class MicrosoftMeetingService {
  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    @Inject(MICROSOFT_GRAPH_PORT) private readonly graph: MicrosoftGraphPort,
    private readonly repo: CommunicationsRepository,
    private readonly config: MicrosoftConfigResolver,
  ) {}

  async createRecruiterMeeting(args: CreateRecruiterMeetingArgs): Promise<MeetingResultView> {
    const connectionId = await this.config.resolveConnectionId(args.tenant_id, args.connection_id);

    // Idempotency: a retried create with the same key returns the existing
    // meeting evidence WITHOUT creating a second meeting.
    const existing = await this.repo.findInteractionByIdempotencyKey(
      args.tenant_id,
      args.idempotency_key,
    );
    if (existing !== null) {
      return this.viewFromRow(existing, args, true);
    }

    const cfg = await this.config.resolveConfig(args.tenant_id, connectionId, true);
    // Bound recruiter's delegated credential ONLY (throws reauth / not-bound).
    const token = await this.delegated.getUsableAccessToken({
      tenant_id: args.tenant_id,
      connection_id: connectionId,
      recruiter_id: args.recruiter_id,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      authorityTenant: cfg.authorityTenant,
      nowEpochSeconds: this.config.nowSeconds(),
    });
    const me = await this.graph.getMe(token.access_token);

    // Create FIRST — NO attendees/invite. A Graph failure throws → NO evidence.
    const meeting = await this.graph.createOnlineMeeting({
      accessToken: token.access_token,
      subject: args.subject,
      startDateTime: args.start_date_time,
      endDateTime: args.end_date_time,
    });

    let interactionId: string;
    try {
      const interaction = await this.repo.createInteraction({
        tenant_id: args.tenant_id,
        channel: 'meeting',
        direction: 'outbound',
        integration_connection_id: connectionId,
        from_address: me.user_principal_name,
        to_address: '', // create-link-only: no recipient/invitee
        initiated_by_id: args.recruiter_id,
        // status defaults to `created`: the meeting LINK was created — NOT
        // attended/completed. C2B never infers attendance or completion (R15/R16).
        idempotency_key: args.idempotency_key,
        provider_interaction_id: meeting.provider_meeting_id,
        join_reference: meeting.join_url,
        started_at: new Date(meeting.start_date_time),
        ended_at: new Date(meeting.end_date_time),
      });
      interactionId = interaction.id;
    } catch {
      const raced = await this.repo.findInteractionByIdempotencyKey(
        args.tenant_id,
        args.idempotency_key,
      );
      if (raced !== null) {
        return this.viewFromRow(raced, args, true);
      }
      throw new Error('meeting evidence write failed');
    }

    await this.repo.addAssociation({
      tenant_id: args.tenant_id,
      interaction_id: interactionId,
      subject_type: 'talent_record',
      subject_id: args.talent_record_id,
      relation_type: 'subject',
    });
    await this.repo.addAssociation({
      tenant_id: args.tenant_id,
      interaction_id: interactionId,
      subject_type: 'requisition',
      subject_id: args.requisition_id,
      relation_type: 'regarding',
    });
    if (args.pipeline_id !== undefined && args.pipeline_id.length > 0) {
      await this.repo.addAssociation({
        tenant_id: args.tenant_id,
        interaction_id: interactionId,
        subject_type: 'pipeline',
        subject_id: args.pipeline_id,
        relation_type: 'regarding',
      });
    }

    return {
      interaction_id: interactionId,
      join_url: meeting.join_url,
      scheduled_start: meeting.start_date_time,
      scheduled_end: meeting.end_date_time,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
      idempotent_replay: false,
    };
  }

  private viewFromRow(
    row: { id: string; join_reference?: string | null; started_at?: Date | null; ended_at?: Date | null },
    args: CreateRecruiterMeetingArgs,
    replay: boolean,
  ): MeetingResultView {
    return {
      interaction_id: row.id,
      join_url: row.join_reference ?? '',
      scheduled_start: row.started_at?.toISOString() ?? args.start_date_time,
      scheduled_end: row.ended_at?.toISOString() ?? args.end_date_time,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
      idempotent_replay: replay,
    };
  }
}
