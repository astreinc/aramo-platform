import { describe, expect, it, vi } from 'vitest';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

// TB-chips — the batched 3-state RTR board chip. The gate maps the CURRENT RTR document status
// (same selectCurrent precedence as the drawer's rtr-orchestrator.current(), so chip == drawer) to
// NOT_SENT / SENT / CONFIRMED, and yields `null` when RTR is NOT required for the requisition (the
// chip renders nothing). CONDITIONAL + bounded (no per-talent loop) — the sibling of assessMany.

function gateWith(over: { requirement?: unknown; statusByTalent?: Map<string, string> }) {
  const documents = {
    findRequirement: vi
      .fn()
      .mockResolvedValue(over.requirement === undefined ? { id: 'rtr-requirement' } : over.requirement),
    findCurrentDocStatusBySubjectTalentIds: vi
      .fn()
      .mockResolvedValue(over.statusByTalent ?? new Map<string, string>()),
    findExecutedSubjectTalentIds: vi.fn(), // unused by assessManyRtrStatus
  };
  const gate = new DocumentReadinessGate(documents as never);
  return { gate, documents };
}

describe('DocumentReadinessGate.assessManyRtrStatus — 3-state board chip (drawer parity)', () => {
  it('RTR NOT required for the requisition → null for every talent; the status query is never issued', async () => {
    const { gate, documents } = gateWith({ requirement: null });
    const out = await gate.assessManyRtrStatus({ tenant_id: 't', requisition_id: 'r', talent_ids: ['a', 'b'] });
    expect(out.get('a')).toBeNull();
    expect(out.get('b')).toBeNull();
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
    const { gate, documents } = gateWith({});
    const out = await gate.assessManyRtrStatus({ tenant_id: 't', requisition_id: 'r', talent_ids: [] });
    expect(out.size).toBe(0);
    expect(documents.findRequirement).not.toHaveBeenCalled();
  });
});
