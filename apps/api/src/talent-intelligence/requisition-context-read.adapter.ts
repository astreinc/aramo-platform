import { Injectable } from '@nestjs/common';
import type { VisibilityContextShape } from '@aramo/common';
import {
  RequisitionRepository,
  RequisitionSkillRequirementRepository,
} from '@aramo/requisition';
import type {
  RequisitionContext,
  RequisitionContextReadPort,
  RequisitionContextSummary,
} from '@aramo/talent-intelligence';

// TIP-E2E INC-2 — RequisitionContextReadAdapter (apps/api composition root).
// Composes the requisition domain repositories ONLY (no cross-schema raw SQL; the
// visibility predicate stays inside libs/requisition). Required DI — a missing
// dependency fails at bootstrap (no @Optional, no silent fallback).
@Injectable()
export class RequisitionContextReadAdapter implements RequisitionContextReadPort {
  constructor(
    private readonly requisitions: RequisitionRepository,
    private readonly skillRequirements: RequisitionSkillRequirementRepository,
  ) {}

  async resolveContext(input: {
    tenant_id: string;
    actor: VisibilityContextShape;
    requisition_id: string;
  }): Promise<RequisitionContext | null> {
    // Authoritative actor-visible requisition read; null = absent OR out-of-visibility.
    const view = await this.requisitions.findByIdForActor({
      tenant_id: input.tenant_id,
      id: input.requisition_id,
      visibility: input.actor,
    });
    if (view === null) return null;
    // R5 — requisition-keyed requirements; raw forms preserved; NOT gated on
    // the requisition's golden_profile_id. Empty only when none are recorded.
    const requirements = await this.skillRequirements.listByRequisitionId(
      input.tenant_id,
      input.requisition_id,
    );
    return {
      requisition_id: view.id,
      status: view.status,
      site_id: view.site_id,
      company_id: view.company_id,
      title: view.title,
      requisition_number: view.requisition_number,
      golden_profile_id: view.golden_profile_id,
      skill_requirements: requirements.map((r) => ({
        requirement_type: r.requirement_type,
        raw_surface_form: r.raw_surface_form,
        version_requirement: r.version_requirement,
        canonical_skill_id: r.canonical_skill_id,
        canonical_version_id: r.canonical_version_id,
        canonicalization_status: r.canonicalization_status,
      })),
    };
  }

  async resolveContexts(input: {
    tenant_id: string;
    actor: VisibilityContextShape;
    requisition_ids: readonly string[];
  }): Promise<ReadonlyMap<string, RequisitionContextSummary>> {
    const out = new Map<string, RequisitionContextSummary>();
    if (input.requisition_ids.length === 0) return out;
    // Option-A visibility: the requisition DOMAIN filters the requested ids by the
    // authoritative predicate (buildVisibilityWhere) — the adapter never
    // re-implements authz and never trusts the caller to pre-resolve visibility.
    // Cross-tenant / actor-invisible / nonexistent ids are dropped here.
    const visibleIds = await this.requisitions.filterVisibleRequisitionIds({
      tenant_id: input.tenant_id,
      visibility: input.actor,
      requisition_ids: input.requisition_ids,
    });
    if (visibleIds.length === 0) return out;
    // Same tenant context for the summary retrieval.
    const summaries = await this.requisitions.findSummariesByIds({
      tenant_id: input.tenant_id,
      ids: visibleIds,
    });
    for (const s of summaries) {
      out.set(s.id, {
        id: s.id,
        requisition_number: s.requisition_number,
        title: s.title,
        company_id: s.company_id,
        status: s.status,
        is_hot: s.is_hot,
        owner_id: s.owner_id,
        recruiter_id: s.recruiter_id,
      });
    }
    return out;
  }
}
