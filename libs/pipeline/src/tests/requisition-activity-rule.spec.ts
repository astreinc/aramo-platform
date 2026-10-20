import { describe, expect, it } from 'vitest';

import {
  isTerminalRequisitionStatus,
  requisitionGateForTransition,
  requisitionPermits,
  type RequisitionPipelineActivity,
} from '../lib/requisition-activity-rule.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §5.1/§5.2 — A1 AM-1 §2.2 as a pure rule,
// asserted cell by cell, plus the per-transition gate (L-3) and the AM-2 terminal set.

const ACTIVITIES: readonly RequisitionPipelineActivity[] = ['ADD', 'CONTACT_SEND', 'CONTACT_EVIDENCE', 'RESPONSE', 'QUALIFY_DECISION'];

describe('requisitionPermits — the A1 AM-1 §2.2 table', () => {
  it('open and on_hold permit every activity (R1: recruiting continues on hold)', () => {
    for (const a of ACTIVITIES) {
      expect(requisitionPermits('open', a), `open·${a}`).toBe(true);
      expect(requisitionPermits('on_hold', a), `on_hold·${a}`).toBe(true);
    }
  });

  it('closed and canceled permit nothing', () => {
    for (const a of ACTIVITIES) {
      expect(requisitionPermits('closed', a), `closed·${a}`).toBe(false);
      expect(requisitionPermits('canceled', a), `canceled·${a}`).toBe(false);
    }
  });

  it('lead (D-2 provisional, A1 §1): Add + contact send + Contacted only', () => {
    expect(requisitionPermits('lead', 'ADD')).toBe(true);
    expect(requisitionPermits('lead', 'CONTACT_SEND')).toBe(true);
    expect(requisitionPermits('lead', 'CONTACT_EVIDENCE')).toBe(true);
    expect(requisitionPermits('lead', 'RESPONSE')).toBe(false);
    expect(requisitionPermits('lead', 'QUALIFY_DECISION')).toBe(false);
  });

  it('statuses A1 leaves unchanged (D-8) are not restricted by this rule', () => {
    for (const s of ['submittals_closed', 'draft', 'pending_approval', 'archived']) {
      for (const a of ACTIVITIES) expect(requisitionPermits(s, a), `${s}·${a}`).toBe(true);
    }
  });

  it('A1 AM-2 — exactly closed and canceled are terminal', () => {
    expect(['closed', 'canceled'].every(isTerminalRequisitionStatus)).toBe(true);
    expect(['open', 'on_hold', 'lead', 'submittals_closed', 'draft', 'pending_approval', 'archived'].some(isTerminalRequisitionStatus)).toBe(false);
  });
});

describe('requisitionGateForTransition (v1.2 §5.2, L-3)', () => {
  const gate = (from: string, to: string, req: string | null, has_disposition = false, system_downstream = false) =>
    requisitionGateForTransition({ from_status: from, to_status: to, requisition_status: req, has_disposition, system_downstream });

  it('forward targets map to their activity and follow the table', () => {
    expect(gate('no_contact', 'contacted', 'closed')).toBe('CONTACT_EVIDENCE');
    expect(gate('contacted', 'talent_responded', 'lead')).toBe('RESPONSE');
    expect(gate('talent_responded', 'qualifying', 'canceled')).toBe('QUALIFY_DECISION');
    expect(gate('qualifying', 'qualified', 'on_hold')).toBeNull();
  });

  it('backward corrections: denied on closed/canceled only', () => {
    expect(gate('qualified', 'qualifying', 'closed')).toBe('BACKWARD_CORRECTION');
    expect(gate('qualified', 'qualifying', 'on_hold')).toBeNull();
  });

  it('not_in_consideration on a terminal requisition needs a governed disposition (with its reason)', () => {
    expect(gate('contacted', 'not_in_consideration', 'closed')).toBe('FINAL_DISPOSITION_WITHOUT_REASON');
    expect(gate('contacted', 'not_in_consideration', 'closed', true)).toBeNull();
    expect(gate('contacted', 'not_in_consideration', 'open')).toBeNull();
  });

  it('system downstream commands and completed are never gated; an unresolved requisition always refuses', () => {
    expect(gate('qualified', 'completed', 'closed')).toBeNull();
    expect(gate('qualified', 'not_in_consideration', 'closed', true, true)).toBeNull();
    expect(gate('talent_responded', 'qualifying', null)).toBe('REQUISITION_UNRESOLVED');
  });
});
