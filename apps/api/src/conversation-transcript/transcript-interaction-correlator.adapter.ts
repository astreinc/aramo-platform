// CI-B5Z — production composition bindings for interaction correlation +
// existence, over the Communications authority (recon: findInteractionBy
// ProviderCorrelation uses the LOCKED priority call_element_id → call_history_uuid
// → call_id, tenant+connection-scoped). Communications remains the interaction
// authority; conversation-transcript only references by UUID.

import { Injectable } from '@nestjs/common';
import { CommunicationsRepository } from '@aramo/communications';
import type { InteractionReferencePort } from '@aramo/conversation-transcript';

import type { TranscriptInteractionCorrelator } from './zoom/zoom-recording-transcript.orchestrator.js';

@Injectable()
export class CommunicationsTranscriptCorrelator implements TranscriptInteractionCorrelator {
  constructor(private readonly repo: CommunicationsRepository) {}

  async correlate(input: {
    tenant_id: string;
    integration_connection_id: string;
    call_element_id?: string;
    call_history_id?: string;
    call_id?: string;
  }): Promise<{ kind: 'matched'; interaction_id: string } | { kind: 'none' } | { kind: 'ambiguous' }> {
    const row = await this.repo.findInteractionByProviderCorrelation(
      input.tenant_id,
      input.integration_connection_id,
      {
        call_element_id: input.call_element_id ?? null,
        call_history_uuid: input.call_history_id ?? null,
        call_id: input.call_id ?? null,
      },
    );
    return row === null ? { kind: 'none' } : { kind: 'matched', interaction_id: row.id };
  }
}

/** INTERACTION_REFERENCE_PORT binding (tenant-safe existence over Communications). */
@Injectable()
export class CommunicationsInteractionReferenceReader implements InteractionReferencePort {
  constructor(private readonly repo: CommunicationsRepository) {}

  async existsInTenant(tenantId: string, interactionId: string): Promise<boolean> {
    return (await this.repo.findInteractionForTenant(tenantId, interactionId)) !== null;
  }
}
