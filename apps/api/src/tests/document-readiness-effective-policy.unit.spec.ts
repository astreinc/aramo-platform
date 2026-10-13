import { describe, expect, it, vi } from 'vitest';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

// RTR effective-policy readiness (correctness) — the ONE canonical interpretation of
// "is RTR required here". Applicability is a POLICY fact, never the existence of a
// DocumentRequirement row:
//   required ⟺ the effective client-submittal-policy declares `rtr_present` REQUIRED.
// This proves the single authority that the Board projection, the Qualification
// transition, Submittal readiness, and the actual Submit-to-client validation all reuse
// (they each call assess/assessMany through this same predicate). `assess` is the public
// window onto isRtrRequired: not required → {satisfied:true}; required + no executed doc →
// {satisfied:false, deny:'SUBMITTAL_RTR_NOT_EXECUTED'}.

const INPUT = { tenant_id: 't1', talent_id: 'tal-1', requisition_id: 'req-1' };

function gate(args: {
  policy: unknown | null;
  companyId?: string | null;
  executed?: boolean;
}) {
  const documents = {
    findExecutedByTypeAndAssociations: vi.fn().mockResolvedValue(args.executed ? { id: 'rtr-doc' } : null),
  };
  const policy = { resolveEffective: vi.fn().mockResolvedValue(args.policy) };
  const companyId = { findCompanyId: vi.fn().mockResolvedValue(args.companyId ?? null) };
  const g = new DocumentReadinessGate(documents as never, policy as never, companyId as never);
  return { g, documents, policy, companyId };
}

const required = { requirements: [{ key: 'rtr_present', disposition: 'REQUIRED' }] };
const notRequired = { requirements: [{ key: 'rtr_present', disposition: 'NOT_REQUIRED' }] };
const otherKeyOnly = { requirements: [{ key: 'work_authorization_present', disposition: 'REQUIRED' }] };

describe('DocumentReadinessGate — effective-policy applicability (the one canonical authority)', () => {
  it('ungoverned tenant (resolveEffective → null) → NOT required → ungated', async () => {
    const { g, documents } = gate({ policy: null });
    const v = await g.assess(INPUT);
    expect(v).toEqual({ satisfied: true, deny: null });
    // The executed-doc satisfaction query is never issued when RTR is not required.
    expect(documents.findExecutedByTypeAndAssociations).not.toHaveBeenCalled();
  });

  it('policy declares rtr_present NOT_REQUIRED → NOT required → ungated', async () => {
    const { g } = gate({ policy: notRequired });
    expect(await g.assess(INPUT)).toEqual({ satisfied: true, deny: null });
  });

  it('policy present but has NO rtr_present key → NOT required → ungated', async () => {
    const { g } = gate({ policy: otherKeyOnly });
    expect(await g.assess(INPUT)).toEqual({ satisfied: true, deny: null });
  });

  it('policy declares rtr_present REQUIRED + no executed RTR → required + denied', async () => {
    const { g } = gate({ policy: required, executed: false });
    const v = await g.assess(INPUT);
    expect(v.satisfied).toBe(false);
    expect(v.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');
  });

  it('policy declares rtr_present REQUIRED + executed RTR exists → required + satisfied', async () => {
    const { g } = gate({ policy: required, executed: true });
    expect(await g.assess(INPUT)).toEqual({ satisfied: true, deny: null });
  });

  it("threads the requisition's company_id into resolveEffective (CLIENT-layer policy)", async () => {
    const { g, policy, companyId } = gate({ policy: required, companyId: 'co-9', executed: false });
    await g.assess(INPUT);
    expect(companyId.findCompanyId).toHaveBeenCalledWith({ tenant_id: 't1', id: 'req-1' });
    expect(policy.resolveEffective).toHaveBeenCalledWith('t1', { company_id: 'co-9', requisition_id: 'req-1' });
  });
});

// =============================================================================
// INC-1c (TIP-E2E) — assessMandatory: the provisional "RTR mandatory before client
// disclosure" interim product policy. UNCONDITIONAL — fails closed for a missing
// executed RTR EVEN when the effective client-submittal policy would not require it
// (the key difference from the policy-conditional `assess`), using the SAME
// same-document executed-RTR predicate (no fabricated verification).
// =============================================================================
describe('DocumentReadinessGate — INC-1c assessMandatory (unconditional RTR)', () => {
  it('executed RTR exists → satisfied (and the policy is NEVER consulted)', async () => {
    const { g, policy } = gate({ policy: notRequired, executed: true });
    expect(await g.assessMandatory(INPUT)).toEqual({ satisfied: true, deny: null });
    expect(policy.resolveEffective).not.toHaveBeenCalled();
  });

  it('no executed RTR → fail-closed deny SUBMITTAL_RTR_NOT_EXECUTED (policy never consulted)', async () => {
    const { g, policy, companyId } = gate({ policy: notRequired, executed: false });
    const v = await g.assessMandatory(INPUT);
    expect(v.satisfied).toBe(false);
    expect(v.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');
    expect(policy.resolveEffective).not.toHaveBeenCalled();
    expect(companyId.findCompanyId).not.toHaveBeenCalled();
  });

  it('UNGOVERNED tenant (policy null) + no executed RTR → STILL denied (stricter than assess)', async () => {
    const { g } = gate({ policy: null, executed: false });
    // assess() would return satisfied:true here (ungated); assessMandatory fails closed.
    expect(await g.assess(INPUT)).toEqual({ satisfied: true, deny: null });
    const v = await g.assessMandatory(INPUT);
    expect(v.satisfied).toBe(false);
    expect(v.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');
  });

  it('issues the same-document executed-RTR query bound to EXACT talent + requisition', async () => {
    const { g, documents } = gate({ policy: null, executed: true });
    await g.assessMandatory(INPUT);
    expect(documents.findExecutedByTypeAndAssociations).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 't1',
        associations: [
          { resource_type: 'TALENT', resource_id: 'tal-1', relationship: 'SUBJECT' },
          { resource_type: 'REQUISITION', resource_id: 'req-1', relationship: 'REGARDING' },
        ],
      }),
    );
  });
});
