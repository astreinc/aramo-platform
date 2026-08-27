import { Injectable } from '@nestjs/common';

import { assertTransition } from './domain/call-state-machine.js';
import {
  CommunicationInteractionNotFoundError,
  CommunicationProviderReferenceConflictError,
} from './domain/errors.js';
import {
  CommunicationsRepository,
  type InteractionRow,
  type InteractionStatusPatch,
} from './communications.repository.js';
import type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationDispositionOutcome,
  CommunicationInteractionStatus,
  CommunicationRelationType,
  CommunicationSubjectType,
} from './domain/communication-enums.js';

// COMM-V1 — domain orchestration (COMM-B1). Owns the state-machine-guarded
// transition and the tenant-safe write boundary: every association/disposition
// first proves the interaction belongs to the acting tenant (a cross-tenant id
// is NOT FOUND — never a silent cross-tenant write). No provider vocabulary and
// no requisition/activity dependency appear here (R-COMM-REQ-BOUNDARY /
// R-COMM-ACTIVITY).

export interface TransitionOptions {
  provider_call_id?: string;
  provider_call_history_uuid?: string;
  provider_call_element_id?: string;
  duration_seconds?: number;
  at?: Date;
}

@Injectable()
export class CommunicationsService {
  constructor(private readonly repo: CommunicationsRepository) {}

  async createOutboundInteraction(args: {
    tenant_id: string;
    integration_connection_id: string;
    channel: CommunicationChannel;
    from_address: string;
    to_address: string;
    initiated_by_id?: string | null;
    site_id?: string | null;
  }): Promise<InteractionRow> {
    return this.repo.createInteraction({
      tenant_id: args.tenant_id,
      site_id: args.site_id ?? null,
      channel: args.channel,
      direction: 'outbound' satisfies CommunicationDirection,
      integration_connection_id: args.integration_connection_id,
      from_address: args.from_address,
      to_address: args.to_address,
      initiated_by_id: args.initiated_by_id ?? null,
    });
  }

  /**
   * State-machine-guarded transition. Loads the interaction tenant-safely,
   * asserts the transition is legal (throws CommunicationInvalidStateError
   * otherwise), stamps the appropriate lifecycle timestamp, and persists.
   */
  async transition(
    tenantId: string,
    interactionId: string,
    target: CommunicationInteractionStatus,
    opts: TransitionOptions = {},
  ): Promise<InteractionRow> {
    const current = await this.repo.findInteractionForTenant(tenantId, interactionId);
    if (current === null) {
      throw new CommunicationInteractionNotFoundError(interactionId);
    }

    assertTransition(current.status, target);

    const at = opts.at ?? new Date();
    const patch: InteractionStatusPatch = { status: target };
    if (target === 'initiated') patch.started_at = at;
    if (target === 'ringing') patch.ringing_at = at;
    if (target === 'connected') patch.connected_at = at;
    if (target === 'completed' || target === 'failed' || target === 'missed' || target === 'rejected') {
      patch.ended_at = at;
    }
    if (opts.duration_seconds !== undefined) patch.duration_seconds = opts.duration_seconds;
    if (opts.provider_call_id !== undefined) patch.provider_call_id = opts.provider_call_id;
    if (opts.provider_call_history_uuid !== undefined)
      patch.provider_call_history_uuid = opts.provider_call_history_uuid;
    if (opts.provider_call_element_id !== undefined)
      patch.provider_call_element_id = opts.provider_call_element_id;

    await this.repo.updateInteractionStatus(tenantId, interactionId, patch);
    const updated = await this.repo.findInteractionForTenant(tenantId, interactionId);
    // Non-null: the row existed at load and this method holds no delete path.
    return updated as InteractionRow;
  }

  /** Associate an interaction with a subject (tenant-safe write boundary). */
  async associate(args: {
    tenant_id: string;
    interaction_id: string;
    subject_type: CommunicationSubjectType;
    subject_id: string;
    relation_type: CommunicationRelationType;
  }): Promise<{ id: string }> {
    const owned = await this.repo.findInteractionForTenant(args.tenant_id, args.interaction_id);
    if (owned === null) {
      throw new CommunicationInteractionNotFoundError(args.interaction_id);
    }
    return this.repo.addAssociation(args);
  }

  /** Record a disposition (tenant-safe write boundary). Locked vocabulary only. */
  async dispose(args: {
    tenant_id: string;
    interaction_id: string;
    disposition: CommunicationDispositionOutcome;
    notes?: string | null;
    dispositioned_by_id: string;
  }): Promise<{ id: string }> {
    const owned = await this.repo.findInteractionForTenant(args.tenant_id, args.interaction_id);
    if (owned === null) {
      throw new CommunicationInteractionNotFoundError(args.interaction_id);
    }
    return this.repo.recordDisposition(args);
  }

  /**
   * COMM-B8 — attach a provider correlation id to an already-created interaction
   * (the embed→provider-id capture that closes the dial-time correlation gap).
   * Tenant+owner-safe: the interaction must belong to `tenantId` AND have been
   * initiated by `recruiterId`, else a tenant-safe NOT FOUND (no disclosure of a
   * peer's interaction). CONVERGENT-or-conflict per field: null → value fills;
   * value === same is a no-op; value → different is REFUSED
   * (CommunicationProviderReferenceConflictError) to protect webhook correlation.
   * Writes ONLY the provider_call_* fields + updated_at — never status, lifecycle
   * timestamps, disposition, duration, or associations.
   */
  async attachProviderReference(
    tenantId: string,
    recruiterId: string,
    interactionId: string,
    refs: {
      provider_call_element_id?: string;
      provider_call_history_uuid?: string;
      provider_call_id?: string;
    },
  ): Promise<{ id: string }> {
    const owned = await this.repo.findInteractionForTenant(tenantId, interactionId);
    // Tenant-safe AND owner-safe: a peer recruiter's interaction is NOT FOUND.
    if (owned === null || owned.initiated_by_id !== recruiterId) {
      throw new CommunicationInteractionNotFoundError(interactionId);
    }

    const fields = [
      'provider_call_element_id',
      'provider_call_history_uuid',
      'provider_call_id',
    ] as const;
    const patch: {
      provider_call_element_id?: string;
      provider_call_history_uuid?: string;
      provider_call_id?: string;
    } = {};
    for (const field of fields) {
      const provided = refs[field];
      if (provided === undefined || provided.length === 0) continue;
      const current = owned[field];
      if (current === null) {
        patch[field] = provided; // fill
      } else if (current !== provided) {
        // Refuse the WHOLE write on any conflicting field (atomic).
        throw new CommunicationProviderReferenceConflictError(field);
      }
      // current === provided → convergent no-op
    }

    if (Object.keys(patch).length > 0) {
      await this.repo.setProviderReference(tenantId, interactionId, patch);
    }
    return { id: interactionId };
  }
}
