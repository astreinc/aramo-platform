import { Inject, Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { CommunicationsRepository } from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  MICROSOFT_GRAPH_PORT,
  type MicrosoftGraphPort,
} from '@aramo/microsoft-graph';

import { EMAIL_CONSENT_GATE, type EmailConsentGate } from './email-consent-gate.port.js';
import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';

// COMM-C2B — recruiter email execution (R11/R12/R13/R16/R17/R19). Consent-gated,
// uses ONLY the bound recruiter's delegated credential, writes a provider-neutral
// CommunicationInteraction (channel=email) associated to Talent × Requisition
// (+ Pipeline where provided) on Graph acceptance. A failed send creates NO
// evidence; a retried send with the same idempotency key never duplicates it;
// NO Pipeline state is mutated and NO token is returned.

export interface SendRecruiterEmailArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly connection_id?: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  readonly to_email: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotency_key: string;
  readonly authContext: AuthContextType;
  readonly requestId: string;
}

export interface EmailSendResultView {
  readonly interaction_id: string;
  readonly status: 'accepted';
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly idempotent_replay: boolean;
}

@Injectable()
export class MicrosoftEmailService {
  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    @Inject(MICROSOFT_GRAPH_PORT) private readonly graph: MicrosoftGraphPort,
    private readonly repo: CommunicationsRepository,
    private readonly config: MicrosoftConfigResolver,
    @Inject(EMAIL_CONSENT_GATE) private readonly consent: EmailConsentGate,
  ) {}

  async sendRecruiterEmail(args: SendRecruiterEmailArgs): Promise<EmailSendResultView> {
    const connectionId = await this.config.resolveConnectionId(args.tenant_id, args.connection_id);

    // Idempotency: a retried send with the same key returns the existing evidence
    // WITHOUT re-sending or duplicating.
    const existing = await this.repo.findInteractionByIdempotencyKey(
      args.tenant_id,
      args.idempotency_key,
    );
    if (existing !== null) {
      return this.view(existing.id, args, true);
    }

    // Consent gate FIRST — a denial creates NO evidence (R17/R19).
    await this.consent.assertEmailContactAllowed({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      authContext: args.authContext,
      requestId: args.requestId,
    });

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

    // Send FIRST; a failed Graph send throws → NO interaction is created (R19).
    await this.graph.sendMail({
      accessToken: token.access_token,
      toEmail: args.to_email,
      subject: args.subject,
      body: args.body,
      idempotencyKey: args.idempotency_key,
    });

    // Accepted → provider-neutral evidence (channel=email, terminal=completed).
    let interactionId: string;
    try {
      const interaction = await this.repo.createInteraction({
        tenant_id: args.tenant_id,
        channel: 'email',
        direction: 'outbound',
        integration_connection_id: connectionId,
        from_address: me.user_principal_name,
        to_address: args.to_email,
        initiated_by_id: args.recruiter_id,
        status: 'completed',
        idempotency_key: args.idempotency_key,
      });
      interactionId = interaction.id;
    } catch {
      // Concurrent retry raced on the partial unique index — resolve the winner.
      const raced = await this.repo.findInteractionByIdempotencyKey(
        args.tenant_id,
        args.idempotency_key,
      );
      if (raced !== null) {
        return this.view(raced.id, args, true);
      }
      throw new Error('email evidence write failed');
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
    return this.view(interactionId, args, false);
  }

  private view(
    interactionId: string,
    args: SendRecruiterEmailArgs,
    replay: boolean,
  ): EmailSendResultView {
    return {
      interaction_id: interactionId,
      status: 'accepted',
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
      idempotent_replay: replay,
    };
  }
}
