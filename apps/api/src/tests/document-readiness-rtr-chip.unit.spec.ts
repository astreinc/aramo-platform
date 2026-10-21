import { describe, expect, it, vi } from 'vitest';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

// TB-chips — the batched RTR board chip. For a REQUIRED requisition the gate maps the CURRENT RTR
// document status (same selectCurrent precedence as the drawer's rtr-orchestrator.current(), so
// chip == drawer) to NOT_SENT / SENT / CONFIRMED. For the non-REQUIRED cases it honours the
// canonical UNRESOLVED ≠ NOT_REQUIRED distinction: an EXPLICIT rtr_present NOT_REQUIRED yields the
// affirmative 'NOT_REQUIRED' chip, while an ungoverned/absent policy yields `null` (render nothing —
// no affirmative "Not required" claim). CONDITIONAL on policy + bounded (no per-talent loop).

// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.7 — an absent policy is UNRESOLVED and
// yields the ACTIONABLE 'POLICY_UNRESOLVED' chip (the former null/UNGOVERNED is superseded).
type Disp = 'REQUIRED' | 'NOT_REQUIRED' | 'UNRESOLVED';
function gateWith(over: { disposition?: Disp; statusByTalent?: Map<string, string> }) {
  const documents = {
    findCurrentDocStatusBySubjectTalentIds: vi
      .fn()
      .mockResolvedValue(over.statusByTalent ?? new Map<string, string>()),
    findExecutedSubjectTalentIds: vi.fn(), // unused by assessManyRtrStatus
  };
  const disposition = over.disposition ?? 'REQUIRED';
  // resolveRequirementSource → NO_LAYER (unresolved); else rtr_present at the given disposition.
  const policy = {
    resolveRequirementSource: vi
      .fn()
      .mockResolvedValue(
        disposition === 'UNRESOLVED'
          ? { state: 'NO_LAYER' }
          : {
              state: 'RESOLVED',
              disposition,
              source: { scope: 'TENANT', scope_ref: null, package_name: 'client-submittal-policy', version: '1', checksum: 'x' },
              composite_version: 'TENANT:1:x',
            },
      ),
  };
  const companyId = { findCompanyId: vi.fn().mockResolvedValue(null) };
  const gate = new DocumentReadinessGate(documents as never, policy as never, companyId as never);
  return { gate, documents, policy };
}

describe('DocumentReadinessGate.assessManyRtrStatus — 3-state board chip (drawer parity)', () => {
  it('UNRESOLVED (no policy) → POLICY_UNRESOLVED for every talent (actionable); status query never issued', async () => {
    const { gate, documents, policy } = gateWith({ disposition: 'UNRESOLVED' });
    const out = await gate.assessManyRtrStatus({ tenant_id: 't', requisition_id: 'r', talent_ids: ['a', 'b'] });
    expect(out.get('a')).toBe('POLICY_UNRESOLVED');
    expect(out.get('b')).toBe('POLICY_UNRESOLVED');
    expect(policy.resolveRequirementSource).toHaveBeenCalled();
    expect(documents.findCurrentDocStatusBySubjectTalentIds).not.toHaveBeenCalled();
  });

  it('EXPLICIT NOT_REQUIRED → the affirmative NOT_REQUIRED chip (never null); status query never issued', async () => {
    const { gate, documents } = gateWith({ disposition: 'NOT_REQUIRED' });
    const out = await gate.assessManyRtrStatus({ tenant_id: 't', requisition_id: 'r', talent_ids: ['a', 'b'] });
    expect(out.get('a')).toBe('NOT_REQUIRED');
    expect(out.get('b')).toBe('NOT_REQUIRED');
    expect(documents.findCurrentDocStatusBySubjectTalentIds).not.toHaveBeenCalled();
  });

  it('maps the current document status → 3-state; a talent with no RTR document → NOT_SENT', async () => {
    const { gate } = gateWith({
      statusByTalent: new Map<string, string>([
        ['exec', 'EXECUTED'],
        ['pending', 'EXECUTION_PENDING'],
        ['prepared', 'PREPARED'],
        ['draft', 'DRAFT'],
        ['voided', 'VOIDED'],
      ]),
    });
    const out = await gate.assessManyRtrStatus({
      tenant_id: 't',
      requisition_id: 'r',
      talent_ids: ['exec', 'pending', 'prepared', 'draft', 'voided', 'nodoc'],
    });
    expect(out.get('exec')).toBe('CONFIRMED');
    expect(out.get('pending')).toBe('SENT');
    expect(out.get('prepared')).toBe('SENT');
    expect(out.get('draft')).toBe('NOT_SENT'); // DRAFT (REQUESTED) → Not sent
    expect(out.get('voided')).toBe('NOT_SENT');
    expect(out.get('nodoc')).toBe('NOT_SENT'); // no RTR document at all
  });

  it('empty talent set → empty map, no reads', async () => {
    const { gate, documents, policy } = gateWith({});
    const out = await gate.assessManyRtrStatus({ tenant_id: 't', requisition_id: 'r', talent_ids: [] });
    expect(out.size).toBe(0);
    expect(policy.resolveRequirementSource).not.toHaveBeenCalled();
    expect(documents.findCurrentDocStatusBySubjectTalentIds).not.toHaveBeenCalled();
  });
});
