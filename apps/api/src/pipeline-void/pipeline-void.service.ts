import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { PipelineRepository, type PipelineView, type VoidReason } from '@aramo/pipeline';
import { CommunicationsRepository } from '@aramo/communications';
import { SubmittalRepository } from '@aramo/submittal';
import { OfferRepository, PlacementRepository } from '@aramo/placement';

// Accidental-Add Correction — the VOID orchestrator (apps/api). VOID's domain transition
// lives in libs/pipeline (PipelineRepository.void), but its eligibility depends on
// cross-domain state that the pipeline lib may NOT import (ADR-0029 pipeline⊥ATS wall +
// comms wall): meaningful requisition-specific engagement (email/voice) and downstream
// business records (Submittal / ClientSelection / Offer / Placement / Pre-Start). So the
// authority is COMPOSED here — the backend, not the caller or the visible stage, decides
// whether the action exists (§5/§6/§7). Precedence: no_contact → downstream → engagement →
// commit. The submit transaction analogue (SubmitTalentToClientService) is the precedent.
@Injectable()
export class PipelineVoidService {
  constructor(
    private readonly pipeline: PipelineRepository,
    private readonly comms: CommunicationsRepository,
    private readonly submittal: SubmittalRepository,
    private readonly offer: OfferRepository,
    private readonly placement: PlacementRepository,
    @Inject('PipelineVoidLogger') private readonly logger: AramoLogger,
  ) {}

  async voidEpisode(args: {
    tenant_id: string;
    pipeline_id: string;
    reason: VoidReason;
    expected_version: number;
    changed_by_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requestId: string;
  }): Promise<PipelineView> {
    const { tenant_id, pipeline_id, requestId } = args;
    const vis = args.visible_requisition_ids;

    // Resolve the episode (404-conceals a non-visible / cross-tenant row — existence never
    // leaked). Yields the (talent, requisition) grain the guards fan out from.
    const episode = await this.pipeline.findByIdForActor({
      tenant_id,
      id: pipeline_id,
      visible_requisition_ids: vis,
    });
    if (episode === null) {
      throw new AramoError('NOT_FOUND', 'Pipeline not found in tenant (or not visible to actor)', 404, {
        requestId,
        details: { id: pipeline_id },
      });
    }
    const talent_record_id = episode.talent_record_id;
    const requisition_id = episode.requisition_id;

    // Gate 1 — strict v1 state: VOID only from no_contact (§5). (repo.void re-checks — defense
    // in depth — but we reject early for the most specific error + to skip the guard reads.)
    if (episode.status !== 'no_contact') {
      throw new AramoError(
        'PIPELINE_VOID_NOT_ALLOWED_FROM_STATE',
        `VOID (remove from requisition) is only allowed from no_contact; current status is ${episode.status}`,
        422,
        { requestId, details: { pipeline_id, current_status: episode.status } },
      );
    }

    // Gate 2 — downstream non-existence (§6). Any Submittal / Offer / Placement (which subsumes
    // ClientSelection via its submittal + Pre-Start via its placement) for this (talent,req) →
    // the episode has advanced past accidental-add; refuse. Reads run concurrently (bounded).
    const [submittal, offers, placements] = await Promise.all([
      this.submittal.findByTenantTalentJobForActor({ tenant_id, talent_id: talent_record_id, job_id: requisition_id, visible_requisition_ids: vis }),
      this.offer.list({ tenant_id, requisition_id, talent_record_id, visible_requisition_ids: vis, limit: 1 }),
      this.placement.listForActor({ tenant_id, requisition_id, talent_record_id, visible_requisition_ids: vis, limit: 1 }),
    ]);
    if (submittal !== null || offers.length > 0 || placements.length > 0) {
      throw new AramoError(
        'PIPELINE_VOID_HAS_DOWNSTREAM_ACTIVITY',
        'This Talent has downstream activity on the requisition and cannot be removed as an accidental add',
        409,
        {
          requestId,
          details: {
            pipeline_id,
            has_submittal: submittal !== null,
            has_offer: offers.length > 0,
            has_placement: placements.length > 0,
          },
        },
      );
    }

    // Gate 3 — engagement non-existence (§7). Any email/voice interaction on this (talent,req)
    // → a real recruiting interaction occurred; refuse (accidental removal must not erase it).
    // V1 fails closed: the read itself throwing propagates (never a silent allow).
    const engaged = await this.comms.findTalentIdsWithRequisitionInteractions({
      tenant_id,
      requisition_id,
      talent_record_ids: [talent_record_id],
    });
    if (engaged.has(talent_record_id)) {
      throw new AramoError(
        'PIPELINE_VOID_HAS_ENGAGEMENT',
        'This Talent has requisition-specific engagement and cannot be removed as an accidental add',
        409,
        { requestId, details: { pipeline_id } },
      );
    }

    // All guards clear — commit the governed VOID (CAS + no_contact re-check + history + slot
    // release are the pipeline lib's; the transition is authoritative + atomic).
    const result = await this.pipeline.void({
      tenant_id,
      id: pipeline_id,
      reason: args.reason,
      expected_version: args.expected_version,
      changed_by_id: args.changed_by_id,
      requestId,
      visible_requisition_ids: vis,
    });
    this.logger.log({ event: 'pipeline_void_orchestrated', tenant_id, pipeline_id, talent_record_id, requisition_id });
    return result;
  }
}
