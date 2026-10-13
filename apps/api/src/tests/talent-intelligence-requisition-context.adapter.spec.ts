import { describe, expect, it } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';
import type {
  RequisitionRepository,
  RequisitionSkillRequirementRepository,
} from '@aramo/requisition';

import { RequisitionContextReadAdapter } from '../talent-intelligence/requisition-context-read.adapter.js';

// TIP-E2E INC-2 §3.1 + Option-A visibility reconciliation. The adapter delegates
// authorization to the requisition domain's filterVisibleRequisitionIds
// (buildVisibilityWhere) and only summarizes the AUTHORIZED subset — it never
// returns arbitrary tenant-matched ids. resolveContext surfaces requisition-keyed
// skills (R5) even when golden_profile_id is null.
const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR: VisibilityContextShape = {
  tenant_id: TENANT,
  actor_user_id: 'user-1',
  see_all_company: false,
  see_all_requisition: false,
  visible_client_ids: new Set<string>(['company-visible']),
};

const VISIBLE = 'req-visible';
const DIFF_SITE_VISIBLE = 'req-diff-site-visible';
const HIDDEN = 'req-hidden';
const OTHER_TENANT = 'req-other-tenant';
const NONEXISTENT = 'req-nonexistent';

function summary(id: string, company_id: string) {
  return {
    id,
    requisition_number: 1001,
    title: 'Senior Engineer',
    company_id,
    status: 'open',
    is_hot: false,
    owner_id: null,
    recruiter_id: null,
  };
}

function build(over: Partial<Record<string, unknown>> = {}) {
  const requisitions = {
    // Domain-authoritative visibility: returns ONLY visible + different-site-visible.
    filterVisibleRequisitionIds: async (args: { requisition_ids: readonly string[] }) =>
      args.requisition_ids.filter((id) => id === VISIBLE || id === DIFF_SITE_VISIBLE),
    findSummariesByIds: async (args: { ids: readonly string[] }) =>
      args.ids.map((id) => summary(id, id === DIFF_SITE_VISIBLE ? 'company-visible' : 'company-visible')),
    findByIdForActor: async (args: { id: string }) =>
      args.id === VISIBLE
        ? ({
            id: VISIBLE,
            status: 'open',
            site_id: 'site-1',
            company_id: 'company-visible',
            title: 'Senior Engineer',
            requisition_number: 1001,
            golden_profile_id: (over['golden_profile_id'] as string | null) ?? null,
          } as unknown)
        : null,
    ...over,
  } as unknown as RequisitionRepository;
  const skills = {
    listByRequisitionId: async () => [
      {
        id: 's1',
        tenant_id: TENANT,
        requisition_id: VISIBLE,
        golden_profile_id: 'gp-x',
        requirement_type: 'required',
        raw_surface_form: 'TypeScript',
        version_requirement: null,
        canonical_skill_id: null,
        canonical_version_id: null,
        canonicalization_status: 'UNRESOLVED',
        canonicalization_method: null,
        canonicalized_at: null,
      },
    ],
  } as unknown as RequisitionSkillRequirementRepository;
  return new RequisitionContextReadAdapter(requisitions, skills);
}

describe('RequisitionContextReadAdapter (INC-2 §3.1 / Option-A)', () => {
  it('resolveContexts: mixed ids → only authorized summaries; different-site-but-visible INCLUDED', async () => {
    const map = await build().resolveContexts({
      tenant_id: TENANT,
      actor: ACTOR,
      requisition_ids: [VISIBLE, DIFF_SITE_VISIBLE, HIDDEN, OTHER_TENANT, NONEXISTENT],
    });
    expect([...map.keys()].sort()).toEqual([DIFF_SITE_VISIBLE, VISIBLE].sort());
    expect(map.has(HIDDEN)).toBe(false);
    expect(map.has(OTHER_TENANT)).toBe(false);
    expect(map.has(NONEXISTENT)).toBe(false);
    expect(map.get(VISIBLE)!.title).toBe('Senior Engineer');
  });

  it('resolveContext: visible requisition with null golden_profile_id STILL returns requisition-keyed skills (R5)', async () => {
    const ctx = await build({ golden_profile_id: null }).resolveContext({
      tenant_id: TENANT,
      actor: ACTOR,
      requisition_id: VISIBLE,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.golden_profile_id).toBeNull();
    expect(ctx!.skill_requirements).toHaveLength(1);
    expect(ctx!.skill_requirements[0]!.raw_surface_form).toBe('TypeScript');
    expect(ctx!.skill_requirements[0]!.canonicalization_status).toBe('UNRESOLVED');
  });

  it('resolveContext: hidden / out-of-visibility requisition → null (404-conceal)', async () => {
    const ctx = await build().resolveContext({
      tenant_id: TENANT,
      actor: ACTOR,
      requisition_id: HIDDEN,
    });
    expect(ctx).toBeNull();
  });
});
