import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import { CommunicationsRepository } from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  MICROSOFT_GRAPH_PORT,
  type MicrosoftGraphPort,
} from '@aramo/microsoft-graph';
import { PipelineRepository } from '@aramo/pipeline';

import { EMAIL_CONSENT_GATE, type EmailConsentGate } from './email-consent-gate.port.js';
import {
  EMAIL_RECIPIENT_RESOLVER,
  type EmailRecipientResolver,
} from './email-recipient-resolver.port.js';
import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';

// COMM-C4 (RCE-1) — the Pipeline scope that authorizes the governed
// no_contact→contacted side effect on send acceptance. Mirrors COMM-C2A voice:
// a recruiter who may send email but not change pipeline status never triggers a
// silent transition (authority preserved).
const PIPELINE_CHANGE_STATUS_SCOPE = 'pipeline:change-status';

// COMM-C2B — recruiter email execution (R11/R12/R13/R16/R17/R19). Consent-gated,
// uses ONLY the bound recruiter's delegated credential, writes a provider-neutral
// CommunicationInteraction (channel=email) associated to Talent × Requisition
// (+ Pipeline where provided) on Graph acceptance. A failed send creates NO
// evidence; a retried send with the same idempotency key never duplicates it;
// NO token is returned. COMM-C4: on Graph acceptance the send MAY advance the
// episode no_contact→contacted via the governed CONTACT action — best-effort,
// only when a pipeline is bound and the caller holds pipeline:change-status;
// it NEVER sets talent_responded and never rolls back the recorded send.

export interface SendRecruiterEmailArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly connection_id?: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly pipeline_id?: string;
  // COMM-C4 — the caller's visible requisition set (global VisibilityInterceptor,
  // threaded from the controller) so the CONTACT side effect honours the SAME
  // concealment the Pipeline surface enforces.
  readonly visible_requisition_ids: ReadonlySet<string> | null;
  // COMM-C4 — no client-supplied recipient. The address is resolved server-side
  // from the Talent record (see EmailRecipientResolver); the browser never
  // supplies `to_email`.
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
  private readonly logger = new Logger(MicrosoftEmailService.name);

  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    @Inject(MICROSOFT_GRAPH_PORT) private readonly graph: MicrosoftGraphPort,
    private readonly repo: CommunicationsRepository,
    private readonly config: MicrosoftConfigResolver,
    @Inject(EMAIL_CONSENT_GATE) private readonly consent: EmailConsentGate,
    @Inject(EMAIL_RECIPIENT_RESOLVER) private readonly recipients: EmailRecipientResolver,
    // COMM-C4 — composition-root read/act into Pipeline for the governed
    // no_contact→contacted orchestration on acceptance (apps/api edge only).
    private readonly pipelines: PipelineRepository,
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

    // COMM-C4 — resolve the AUTHORITATIVE recipient from the live TalentRecord.
    // The client supplies no address; a Talent with no email1 (or a cross-tenant/
    // absent Talent, which yields no row) fails closed HERE — before any Graph
    // call and before any CommunicationInteraction is written.
    const toAddress = await this.recipients.resolveRecipientEmail({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
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
      toEmail: toAddress,
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
        to_address: toAddress,
        initiated_by_id: args.recruiter_id,
        status: 'completed',
        idempotency_key: args.idempotency_key,
        // COMM-C4 — persist the FINAL reviewed subject/body as durable evidence.
        subject: args.subject,
        body: args.body,
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

    // COMM-C4 — governed no_contact→contacted on acceptance. A durable email
    // send now exists. Best-effort, and ONLY when a pipeline is bound and the
    // caller holds pipeline:change-status (a recruiter who may email but not
    // change status never triggers a silent transition).
    if (
      args.pipeline_id !== undefined &&
      args.pipeline_id.length > 0 &&
      args.authContext.scopes.includes(PIPELINE_CHANGE_STATUS_SCOPE)
    ) {
      await this.maybeAdvanceToContacted(args, args.pipeline_id);
    }
    return this.view(interactionId, args, false);
  }

  /**
   * COMM-C4 — advance the bound episode no_contact→contacted through the governed
   * CONTACT action iff it is still no_contact. AUTHORITATIVE: the pipeline is
   * resolved tenant/visibility-scoped and validated to match this Talent ×
   * Requisition (never browser-authoritative). Never replays past `contacted`,
   * never sets talent_responded, never bypasses the state machine/CAS, and NEVER
   * throws — the email evidence is already durable, so any anomaly (concealed/
   * absent/mismatched pipeline, CAS conflict, transition error) is logged and the
   * send result is preserved. Mirrors the COMM-C2A voice orchestration.
   */
  private async maybeAdvanceToContacted(args: SendRecruiterEmailArgs, pipelineId: string): Promise<void> {
    try {
      const pipeline = await this.pipelines.findByIdForActor({
        tenant_id: args.tenant_id,
        id: pipelineId,
        visible_requisition_ids: args.visible_requisition_ids,
      });
      if (
        pipeline === null ||
        pipeline.requisition_id !== args.requisition_id ||
        pipeline.talent_record_id !== args.talent_record_id ||
        pipeline.status !== 'no_contact'
      ) {
        return;
      }
      await this.pipelines.applyAction({
        tenant_id: args.tenant_id,
        id: pipeline.id,
        action: 'CONTACT',
        expected_version: pipeline.version,
        changed_by_id: args.recruiter_id,
        requestId: args.requestId,
        visible_requisition_ids: args.visible_requisition_ids,
      });
    } catch (err) {
      this.logger.warn(
        `communication.email_contact_orchestration_skipped tenant=${args.tenant_id} pipeline=${pipelineId} reason=${
          err instanceof AramoError ? err.code : 'unknown'
        }`,
      );
    }
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
