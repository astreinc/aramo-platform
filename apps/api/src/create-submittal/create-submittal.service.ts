import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PipelineRepository } from '@aramo/pipeline';
import {
  SubmittalRepository,
  type CreateSubmittalInput,
  type TalentSubmittalRecordView,
} from '@aramo/submittal';

// SW-1 (Submittal Workspace, R1-A) — the apps/api composition root for the
// "create submittal" product command. This is the ONE place @aramo/pipeline and
// @aramo/submittal meet for create: it derives the authoritative pipeline_id
// SERVER-SIDE from the sole live Pipeline episode (Pipeline-domain authority) and
// forwards it to SubmittalRepository.createSubmittal (Submittal-persistence
// authority). The HTTP caller never supplies pipeline_id.
//
// Boundary: libs/submittal remains unaware of Pipeline — the two domains cross
// ONLY here, in apps/api (no libs/submittal -> libs/pipeline edge, no connector
// port). Pipeline owns episode identity/live semantics; Submittal owns
// TalentSubmittalRecord persistence/lifecycle; apps/api composes them.

// The orchestrator input is the repository CreateSubmittalInput MINUS pipeline_id
// (which is never caller-authoritative — it is derived here) PLUS the HTTP
// request_id used for error-envelope binding.
export type CreateSubmittalDerivedInput = Omit<CreateSubmittalInput, 'pipeline_id'> & {
  readonly requestId: string;
};

@Injectable()
export class CreateSubmittalOrchestrator {
  constructor(
    private readonly pipelineRepository: PipelineRepository,
    private readonly submittalRepository: SubmittalRepository,
  ) {}

  async create(input: CreateSubmittalDerivedInput): Promise<TalentSubmittalRecordView> {
    // Derive THE sole live Pipeline episode for the (tenant, talent, requisition)
    // triple using the canonical Pipeline live/terminal semantics. The
    // `Pipeline_live_episode_key` partial unique index guarantees at most one live
    // episode, so a non-null result is deterministic; and because the reader keys
    // on all three identity columns, a returned episode is identity-matched BY
    // CONSTRUCTION (cross-tenant / talent / requisition mismatches cannot be
    // manufactured through this create path). The submit command still re-validates
    // the link fail-closed at submit time.
    const live = await this.pipelineRepository.findLiveEpisode({
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_id,
      requisition_id: input.job_id,
    });
    if (live === null) {
      // No live episode: none created, or every episode for the triple has reached
      // a canonical terminal status (not_in_consideration / completed / voided).
      // Terminal-only history is NOT silently bound to a new submittal — refuse.
      throw new AramoError(
        'SUBMITTAL_NO_LIVE_PIPELINE_EPISODE',
        'No live pipeline episode exists for this Talent and requisition; add the Talent to the pipeline before creating a submittal',
        409,
        {
          requestId: input.requestId,
          details: { talent_id: input.talent_id, requisition_id: input.job_id },
        },
      );
    }

    const { requestId: _requestId, ...createInput } = input;
    void _requestId;
    return this.submittalRepository.createSubmittal({
      ...createInput,
      // R1-A — the authoritative link, derived server-side from the live episode.
      pipeline_id: live.id,
    });
  }
}
