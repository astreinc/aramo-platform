import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { SubmittalRepository, TalentSubmittalEventRepository } from '@aramo/submittal';

import type {
  JourneyAuditEntry,
  TalentJourneyAuditView,
} from './dto/talent-journey-audit.view.js';

// INC-1e (TIP-E2E) — the correlated journey audit read. READ-ONLY: it composes the
// EXISTING immutable TalentSubmittalEvent timeline + the durable domain IDs for one
// submittal grain; it writes nothing and introduces no new audit authority.
//
// SECURITY (INC-1e §6 — audit reads do not cross tenant/site/visibility boundaries):
// the submittal is resolved under the actor's requisition-visibility via the same
// findByIdForActor predicate the submittal reads use. A cross-tenant OR out-of-visibility
// submittal yields null → 404 (existence is NOT disclosed; never 403), and the immutable
// event read is never issued — so an unauthorized caller learns nothing.
@Injectable()
export class TalentJourneyAuditService {
  constructor(
    private readonly submittal: SubmittalRepository,
    private readonly events: TalentSubmittalEventRepository,
  ) {}

  async getAuditTrace(args: {
    tenant_id: string;
    submittal_id: string;
    // The pre-resolved AUTHZ visible-requisition set (null = see_all). Matches
    // req.resolveVisibleRequisitionIds().
    visible_requisition_ids: ReadonlySet<string> | null;
    requestId: string;
  }): Promise<TalentJourneyAuditView> {
    // Gate — tenant + requisition-visibility existence check. Null conceals both
    // "absent" and "not visible / cross-tenant" as the SAME 404.
    const submittal = await this.submittal.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.submittal_id,
      visible_requisition_ids: args.visible_requisition_ids,
    });
    if (submittal === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Submittal journey not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { submittal_id: args.submittal_id } },
      );
    }

    // Immutable submittal-transition events (tenant-scoped), chronological. Read only
    // AFTER the visibility gate passes.
    const events = await this.events.findByTenantAndSubmittalId({
      tenant_id: args.tenant_id,
      submittal_id: submittal.id,
    });

    const entries: JourneyAuditEntry[] = events.map((e) => ({
      source: 'submittal',
      kind: e.event_type,
      occurred_at: e.created_at.toISOString(),
      actor_id: extractActorId(e.event_payload),
      submittal_event_id: e.id,
    }));

    return {
      spine: {
        submittal_id: submittal.id,
        talent_id: submittal.talent_id,
        requisition_id: submittal.job_id,
        examination_id: submittal.pinned_examination_id,
        evidence_package_id: submittal.evidence_package_id,
      },
      record_provenance: { created_by: submittal.created_by },
      entries,
    };
  }
}

// Surface authenticated actor provenance from an immutable event payload where it was
// recorded. HONEST null when absent — never fabricated. Checks the known provenance
// keys the submittal event payloads use; order is first-match.
function extractActorId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['actor_id', 'submitted_by_actor_id', 'performed_by', 'revoked_by', 'created_by']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
