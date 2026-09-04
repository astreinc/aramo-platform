import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { AramoError, E164NormalizationError, normalizeToE164 } from '@aramo/common';
import {
  CommunicationsRepository,
  CommunicationsService,
  REQUISITION_EXISTENCE_PORT,
  VoiceProviderRegistry,
  type RequisitionExistencePort,
} from '@aramo/communications';
import { ConsentService } from '@aramo/consent';
import { IntegrationConnectionService } from '@aramo/integration';
import { PipelineRepository, type PipelineView } from '@aramo/pipeline';
import { TalentRecordRepository } from '@aramo/talent-record';

import type { CallPhoneSlot, CommunicationInteractionViewDto, InitiateCommunicationCallDto } from './dto/communications.dto.js';

// COMM-C2A — the Pipeline scope that authorizes the governed no_contact→contacted
// side effect. The orchestration only fires when the caller actually holds it, so
// a recruiter who may place a call but not change pipeline status never triggers a
// silent transition (authority preserved, R6).
const PIPELINE_CHANGE_STATUS_SCOPE = 'pipeline:change-status';

// COMM-B5 — apps/api call-initiation orchestration. Lives at the composition root
// (NOT libs/communications) so the domain stays free of consent/integration/
// requisition/talent nx edges. Implements the LOCKED execution order exactly:
//
//   resolve Talent phone slot -> normalize E.164 -> validate optional regarding
//   -> resolve tenant zoom_phone connection -> resolve recruiter provider
//   identity -> CONSENT CHECK (operation=communication, channel=phone) -> only if
//   allowed create the interaction (`created`) -> call provider -> transition
//   created->initiated on success, created->failed on a provider-launch failure.
//
// SECURITY INVARIANT: no provider is called before consent SUCCEEDS. The consent
// gate is fail-closed — BOTH an explicit `denied` and a system `error` refuse the
// call with the single stable code COMMUNICATION_CALL_CONSENT_DENIED; the
// denied-vs-failure distinction is retained in the audit log ONLY, never leaked
// to the caller. Idempotency (Idempotency-Key) is enforced by the controller.

const ZOOM_PHONE_PROVIDER_KEY = 'zoom_phone';

@Injectable()
export class CommunicationCallService {
  private readonly logger = new Logger(CommunicationCallService.name);

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly comms: CommunicationsService,
    private readonly repo: CommunicationsRepository,
    private readonly connections: IntegrationConnectionService,
    private readonly providers: VoiceProviderRegistry,
    private readonly consent: ConsentService,
    @Inject(REQUISITION_EXISTENCE_PORT) private readonly requisitions: RequisitionExistencePort,
    // COMM-C2A — composition-root read/act into Pipeline for the governed
    // no_contact→contacted orchestration. apps/api is the composition root; NO
    // libs/communications → pipeline edge is created (R6).
    private readonly pipelines: PipelineRepository,
  ) {}

  async initiate(
    auth: AuthContextType,
    dto: InitiateCommunicationCallDto,
    requestId: string,
    // COMM-C2A — the caller's visible requisition set (resolved by the global
    // VisibilityInterceptor in the controller). Threaded through so the CONTACT
    // orchestration honours the SAME concealment the Pipeline surface enforces.
    visibleRequisitionIds: ReadonlySet<string> | null,
  ): Promise<CommunicationInteractionViewDto> {
    const tenantId = auth.tenant_id;
    const recruiterId = auth.sub;

    // 1) Resolve the Talent phone slot server-side (never a client number).
    const phones = await this.talentRecords.findDialablePhonesForTenant({
      tenant_id: tenantId,
      id: dto.talent_id,
    });
    if (phones === null) {
      throw new AramoError('NOT_FOUND', 'Talent record not found in tenant', 404, {
        requestId,
        details: { talent_id: dto.talent_id },
      });
    }
    const rawNumber = pickSlot(phones, dto.phone_slot);
    if (rawNumber === null || rawNumber.trim().length === 0) {
      throw new AramoError(
        'COMMUNICATION_CALL_NOT_INITIABLE',
        'no dialable number on file for the selected slot',
        422,
        { requestId, details: { phone_slot: dto.phone_slot } },
      );
    }

    // 2) Normalize to a dialable E.164 destination; refuse if not normalizable.
    let toAddress: string;
    try {
      toAddress = normalizeToE164(rawNumber);
    } catch (err) {
      if (err instanceof E164NormalizationError) {
        throw new AramoError(
          'COMMUNICATION_CALL_NOT_INITIABLE',
          'the number on file could not be normalized to a dialable format',
          422,
          { requestId, details: { phone_slot: dto.phone_slot } },
        );
      }
      throw err;
    }

    // 3) Validate optional `regarding` requisition (tenant-safe existence).
    let pipeline: PipelineView | null = null;
    if (dto.regarding !== undefined && dto.regarding !== null) {
      const exists = await this.requisitions.exists(tenantId, dto.regarding.requisition_id);
      if (!exists) {
        throw new AramoError(
          'COMMUNICATION_CALL_NOT_INITIABLE',
          'the referenced requisition does not exist in this tenant',
          422,
          { requestId, details: { requisition_id: dto.regarding.requisition_id } },
        );
      }

      // COMM-C2A (R5) — when a Pipeline episode is supplied, the evidence-bearing
      // call MUST be reliably attributable to the Talent × Requisition. Resolve
      // it with the caller's visibility (a non-visible/absent pipeline conceals as
      // "not initiable"), and confirm it matches BOTH the Talent and Requisition.
      if (dto.regarding.pipeline_id !== undefined) {
        pipeline = await this.pipelines.findByIdForActor({
          tenant_id: tenantId,
          id: dto.regarding.pipeline_id,
          visible_requisition_ids: visibleRequisitionIds,
        });
        if (
          pipeline === null ||
          pipeline.requisition_id !== dto.regarding.requisition_id ||
          pipeline.talent_record_id !== dto.talent_id
        ) {
          throw new AramoError(
            'COMMUNICATION_CALL_NOT_INITIABLE',
            'the referenced pipeline does not match this talent and requisition',
            422,
            { requestId, details: { pipeline_id: dto.regarding.pipeline_id } },
          );
        }
      }
    }

    // 4) Resolve the tenant's usable zoom_phone connection + its adapter.
    const connection = await this.connections.findConnectionByProviderKey(
      tenantId,
      ZOOM_PHONE_PROVIDER_KEY,
    );
    const provider = connection === null ? null : this.providers.resolve(connection.provider_key);
    if (connection === null || provider === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }

    // 5) Resolve the calling recruiter's provider-identity mapping.
    const identity = await this.repo.findProviderIdentityByRecruiter(tenantId, recruiterId);
    if (identity === null) {
      throw new AramoError(
        'COMMUNICATION_USER_NOT_MAPPED',
        'The caller has no communications provider identity mapping',
        404,
        { requestId },
      );
    }

    // 6) CONSENT — operation=communication, channel=phone. Fail-closed: any
    // non-allowed result (denied OR system error) refuses the call BEFORE any
    // interaction is created or any provider is called.
    const decision = await this.consent.check(
      { talent_record_id: dto.talent_id, operation: 'communication', channel: 'phone' },
      undefined,
      auth,
      requestId,
    );
    if (decision.result !== 'allowed') {
      // Audit retains the denied-vs-failure distinction; the caller does not.
      this.logger.warn(
        `communication.call_refused tenant=${tenantId} talent=${dto.talent_id} recruiter=${recruiterId} consent_result=${decision.result} reason_code=${decision.reason_code ?? ''}`,
      );
      throw new AramoError(
        'COMMUNICATION_CALL_CONSENT_DENIED',
        'contacting consent is required to place this call',
        403,
        { requestId, details: { talent_id: dto.talent_id } },
      );
    }

    // 7) Only after consent — create the interaction (`created`) + associations.
    const fromAddress =
      identity.display_phone_number ?? identity.extension ?? identity.provider_user_id;
    const interaction = await this.comms.createOutboundInteraction({
      tenant_id: tenantId,
      integration_connection_id: connection.id,
      channel: 'voice',
      from_address: fromAddress,
      to_address: toAddress,
      initiated_by_id: recruiterId,
    });
    await this.comms.associate({
      tenant_id: tenantId,
      interaction_id: interaction.id,
      subject_type: 'talent_record',
      subject_id: dto.talent_id,
      relation_type: 'subject',
    });
    if (dto.regarding !== undefined && dto.regarding !== null) {
      await this.comms.associate({
        tenant_id: tenantId,
        interaction_id: interaction.id,
        subject_type: 'requisition',
        subject_id: dto.regarding.requisition_id,
        relation_type: 'regarding',
      });
      // COMM-C2A (R5) — additive Pipeline association using the already-admitted
      // subject_type='pipeline', so the (Talent × Requisition × Pipeline) context
      // is durably recoverable for the derived engagement read.
      if (pipeline !== null) {
        await this.comms.associate({
          tenant_id: tenantId,
          interaction_id: interaction.id,
          subject_type: 'pipeline',
          subject_id: pipeline.id,
          relation_type: 'regarding',
        });
      }
    }

    // 8) Call the provider — after create. Transition on the outcome.
    try {
      await provider.initiateCall({
        tenant_id: tenantId,
        integration_connection_id: connection.id,
        channel: 'voice',
        direction: 'outbound',
        from_address: fromAddress,
        to_address: toAddress,
        initiated_by_id: recruiterId,
        caller: {
          provider_user_id: identity.provider_user_id,
          provider_extension_id: identity.provider_extension_id,
          extension: identity.extension,
        },
      });
    } catch {
      // Provider launch failed before ringing → auditable terminal `failed`.
      await this.comms.transition(tenantId, interaction.id, 'failed');
      this.logger.warn(
        `communication.launch_failed tenant=${tenantId} interaction=${interaction.id}`,
      );
      throw new AramoError('COMMUNICATION_CALL_NOT_INITIABLE', 'the call could not be initiated', 422, {
        requestId,
        details: { interaction_id: interaction.id },
      });
    }

    const initiated = await this.comms.transition(tenantId, interaction.id, 'initiated');

    // 9) COMM-C2A (R6) — governed no_contact→contacted orchestration. A durable
    // voice attempt now exists. If the caller holds pipeline authority and the
    // episode is still `no_contact`, drive the governed CONTACT action through the
    // Pipeline state machine (never a direct status write). BEST-EFFORT: a CAS
    // conflict, concealment, or any Pipeline error is swallowed — the
    // communication evidence is preserved and never rolled back.
    if (pipeline !== null && auth.scopes.includes(PIPELINE_CHANGE_STATUS_SCOPE)) {
      await this.maybeAdvanceToContacted(auth, pipeline, visibleRequisitionIds, requestId);
    }

    return toView(initiated);
  }

  /**
   * COMM-C2A — drive the governed CONTACT action iff the episode is still
   * `no_contact`. Never replays past `contacted` (R6), never bypasses the state
   * machine/CAS, and never throws: evidence is already durable, so a failed
   * transition is logged and reconciled-safe, not surfaced to the caller.
   */
  private async maybeAdvanceToContacted(
    auth: AuthContextType,
    pipeline: PipelineView,
    visibleRequisitionIds: ReadonlySet<string> | null,
    requestId: string,
  ): Promise<void> {
    if (pipeline.status !== 'no_contact') return;
    try {
      await this.pipelines.applyAction({
        tenant_id: auth.tenant_id,
        id: pipeline.id,
        action: 'CONTACT',
        expected_version: pipeline.version,
        changed_by_id: auth.sub,
        requestId,
        visible_requisition_ids: visibleRequisitionIds,
      });
    } catch (err) {
      // Reconcile-safe: preserve the evidence, do not fail the call.
      this.logger.warn(
        `communication.contact_orchestration_skipped tenant=${auth.tenant_id} pipeline=${pipeline.id} reason=${err instanceof AramoError ? err.code : 'unknown'}`,
      );
    }
  }
}

function pickSlot(
  phones: { phone_cell: string | null; phone_work: string | null; phone_home: string | null },
  slot: CallPhoneSlot,
): string | null {
  switch (slot) {
    case 'cell':
      return phones.phone_cell;
    case 'work':
      return phones.phone_work;
    case 'home':
      return phones.phone_home;
  }
}

function toView(row: {
  id: string;
  channel: CommunicationInteractionViewDto['channel'];
  direction: CommunicationInteractionViewDto['direction'];
  status: CommunicationInteractionViewDto['status'];
  integration_connection_id: string;
  from_address: string;
  to_address: string;
  started_at: Date | null;
  ringing_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  updated_at: Date;
}): CommunicationInteractionViewDto {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    integration_connection_id: row.integration_connection_id,
    from_address: row.from_address,
    to_address: row.to_address,
    started_at: row.started_at === null ? null : row.started_at.toISOString(),
    ringing_at: row.ringing_at === null ? null : row.ringing_at.toISOString(),
    connected_at: row.connected_at === null ? null : row.connected_at.toISOString(),
    ended_at: row.ended_at === null ? null : row.ended_at.toISOString(),
    duration_seconds: row.duration_seconds,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
