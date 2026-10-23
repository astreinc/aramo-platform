import { Inject, Injectable } from '@nestjs/common';
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  validateActProposalRequest,
  validateDismissProposalRequest,
  type ProposalAction,
  type ProposalKind,
  type ProposalListResponse,
  type ProposalStatus,
  type ProposalTriggerKind,
  type ProposalView,
} from '@aramo/intelligence-contracts';

import { survivingSubject } from '../identity/identity-resolution.service.js';
import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type TenantKey,
  type VerificationProposal,
} from '../repositories/types.js';

import { decodeCursor, encodeCursor, pageLimit, refused, requireEntitledTenant, tenantActor, tenantReferencesOn } from './lifecycle-access.js';

// ATI-SEP-1 T10 M-2 — the trust-proposal worklist (the caseworker queue). The
// projection generates the rows (lifecycle/proposal-generator.ts, per tenant
// view); this service LISTS them for a tenant and records a human's DISMISS or
// ACT. It executes nothing: every real action is a separately gated call
// (verification request, contradiction resolution, an ATS record edit) — the
// proposal only records that a human took it (propose-never-dispose).
//
// Visibility: the tenant must be entitled; a proposal is the tenant's own row
// and is shown only while its subject still holds an ACTIVE reference of the
// tenant (an erased / merged-away subject drops off the queue). Else 404.

@Injectable()
export class ProposalService {
  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  async list(
    sourceTenantId: string,
    principal: IngestPrincipal,
    query: { status?: unknown; kind?: unknown; cursor?: unknown; limit?: unknown },
  ): Promise<ProposalListResponse> {
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: sourceTenantId };
    const status = query.status === undefined || query.status === '' ? 'OPEN' : query.status;
    if (!(PROPOSAL_STATUSES as readonly unknown[]).includes(status)) throw refused('INVALID_REQUEST', [`status: ${PROPOSAL_STATUSES.join(' | ')}`]);
    const kind = query.kind === undefined || query.kind === '' ? null : query.kind;
    if (kind !== null && !(PROPOSAL_KINDS as readonly unknown[]).includes(kind)) throw refused('INVALID_REQUEST', [`kind: ${PROPOSAL_KINDS.join(' | ')}`]);
    const after = decodeCursor(query.cursor);
    const limit = pageLimit(query.limit);
    return this.uow.run(async (repos) => {
      await requireEntitledTenant(repos, principal, tenant);
      const rows = await repos.proposals.listForTenant(tenant, { status: status as string, kind: kind as string | null, after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const items: ProposalView[] = [];
      for (const p of page) items.push(await this.view(repos, p, tenant));
      const last = page[page.length - 1];
      return { items, next_cursor: rows.length > limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null };
    });
  }

  async dismiss(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<ProposalView> {
    const v = validateDismissProposalRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: v.value.source_tenant_id };
    return this.transition(id, tenant, principal, {
      status: 'DISMISSED',
      resolved_by: tenantActor(tenant, v.value.actor),
      justification: v.value.justification,
      at: now,
    });
  }

  async act(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<ProposalView> {
    const v = validateActProposalRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: v.value.source_tenant_id };
    return this.transition(id, tenant, principal, {
      status: 'ACTED',
      resolved_by: tenantActor(tenant, v.value.actor),
      action: v.value.action,
      note: v.value.note ?? null,
      at: now,
    });
  }

  private transition(
    id: string,
    tenant: TenantKey,
    principal: IngestPrincipal,
    patch: { status: 'DISMISSED' | 'ACTED'; resolved_by: string; justification?: string; action?: string; note?: string | null; at: Date },
  ): Promise<ProposalView> {
    return this.uow.run(
      async (repos) => {
        await requireEntitledTenant(repos, principal, tenant);
        const p = await repos.proposals.findById(id);
        if (p === null || p.source_system_id !== tenant.source_system_id || p.source_tenant_id !== tenant.source_tenant_id) throw refused('NOT_FOUND');
        const subject = await survivingSubject(repos, p.subject_id);
        if (subject.id !== p.subject_id || subject.access_state !== 'ACTIVE' || (await tenantReferencesOn(repos, p.subject_id, tenant)).length === 0) {
          throw refused('NOT_FOUND');
        }
        if (p.status !== 'OPEN') throw refused('PROPOSAL_NOT_OPEN');
        const next = await repos.proposals.resolve(p.id, patch);
        if (next === null) throw refused('PROPOSAL_NOT_OPEN');
        return this.view(repos, next, tenant);
      },
      { lockKeys: [`proposal:${id}`] },
    );
  }

  private async view(repos: IntelligenceRepositories, p: VerificationProposal, tenant: TenantKey): Promise<ProposalView> {
    const snapshot = (p.basis_snapshot ?? {}) as { assertion_type?: unknown };
    return {
      proposal_id: p.id,
      external_talent_ids: (await tenantReferencesOn(repos, p.subject_id, tenant)).map((r) => r.external_talent_id).sort(),
      kind: p.kind as ProposalKind,
      trigger_kind: p.trigger_kind as ProposalTriggerKind,
      status: p.status as ProposalStatus,
      assertion_id: p.assertion_id,
      assertion_type: typeof snapshot.assertion_type === 'string' ? snapshot.assertion_type : null,
      identifier_type: p.identifier_type as ProposalView['identifier_type'],
      identifier_digest: p.identifier_digest,
      justification: p.justification,
      action: p.action as ProposalAction | null,
      created_at: p.created_at.toISOString(),
      acted_at: p.acted_at?.toISOString() ?? null,
    };
  }
}
