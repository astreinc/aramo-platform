import { describe, it, expect } from 'vitest';

import {
  clientSelectionPill,
  deliveryLabel,
  entryActionLabel,
  isHistorical,
  lifecyclePill,
  remediationOnRequisition,
  requiredCounts,
  requirementRow,
  submittalEntryHref,
} from './present';
import type { SubmittalReadiness, SubmittalRequirement } from './submittal-workspace-types';

function req(overrides: Partial<SubmittalRequirement> = {}): SubmittalRequirement {
  return {
    key: 'rtr', label: 'Right to Represent', required: true, satisfied: true,
    severity: 'blocking', source: 'documents', reason: null, remediation: null, deny_code: null,
    ...overrides,
  };
}

describe('present — lifecycle + client pills', () => {
  it('maps submittal lifecycle states to the distinct pill (never readiness)', () => {
    expect(lifecyclePill('handoff_draft')).toMatchObject({ tone: 'warn', label: 'Preparing' });
    expect(lifecyclePill('ready_for_review')).toMatchObject({ tone: 'info', label: 'Ready for review' });
    expect(lifecyclePill('submitted_to_client')).toMatchObject({ tone: 'ok', label: 'Submitted to client' });
    expect(lifecyclePill('revoked')).toMatchObject({ tone: 'neutral', label: 'Revoked' });
  });

  it('maps ClientSelection states; null → no pill', () => {
    expect(clientSelectionPill('CLIENT_REVIEW')).toMatchObject({ label: 'Client review' });
    expect(clientSelectionPill('INTERVIEW')).toMatchObject({ label: 'Interview' });
    expect(clientSelectionPill('DECLINED')).toMatchObject({ tone: 'danger', label: 'Declined' });
    expect(clientSelectionPill(null)).toBeNull();
  });
});

describe('present — delivery vocabulary (maps exactly to SW-2 enum values)', () => {
  it('labels the V1 manual channels and never surfaces a bare transport verb', () => {
    expect(deliveryLabel('manual_vms')).toBe('Manual VMS');
    expect(deliveryLabel('manual_client_portal')).toBe('Client portal');
    expect(deliveryLabel('manual_email')).toBe('Email (outside Aramo)');
    expect(deliveryLabel('manual_other')).toBe('Other manual method');
    expect(deliveryLabel(null)).toBe('Not recorded');
  });
});

describe('present — entry labels + hrefs (lifecycle-aware; §8)', () => {
  it('derives the lifecycle action label from the submittal state', () => {
    expect(entryActionLabel(null)).toBe('Prepare submittal');
    expect(entryActionLabel('handoff_draft')).toBe('Continue preparation');
    expect(entryActionLabel('ready_for_review')).toBe('Review submittal');
    expect(entryActionLabel('submitted_to_client')).toBe('View submittal');
    expect(entryActionLabel('revoked')).toBe('View submittal');
  });

  it('routes an existing submittal to the workspace, a missing one to create', () => {
    expect(submittalEntryHref('t1', 'r1', 'ready_for_review')).toBe('/talent/t1/submittal/r1/workspace');
    expect(submittalEntryHref('t1', 'r1', null)).toBe('/talent/t1/submittal/r1');
  });
});

describe('present — requirement rows + counts (display-only; readiness stays authoritative)', () => {
  it('counts satisfied REQUIRED rows for display without deciding readiness', () => {
    const readiness: SubmittalReadiness = {
      status: 'BLOCKED',
      requirements: [
        req({ key: 'a', satisfied: true }),
        req({ key: 'b', satisfied: false }),
        req({ key: 'c', satisfied: true, required: false }), // not required → excluded
      ],
    };
    // 1 of 2 required satisfied — a presentation count, NOT the band.
    expect(requiredCounts(readiness)).toEqual({ done: 1, total: 2 });
    // The count says "1 of 2" but readiness.status is authoritative and BLOCKED.
    expect(readiness.status).toBe('BLOCKED');
  });

  it('renders row state from the server satisfied flag + historical-ness (never the key)', () => {
    expect(requirementRow(req({ satisfied: true }), false)).toMatchObject({ mark: '✓', statusText: 'Complete' });
    expect(requirementRow(req({ satisfied: true }), true)).toMatchObject({ mark: '✓', statusText: 'Met at handoff' });
    expect(requirementRow(req({ satisfied: false }), false)).toMatchObject({ mark: '!', statusText: 'Needs attention' });
  });

  it('offers an Open-requisition remediation only for unsatisfied requisition-scoped sources', () => {
    expect(remediationOnRequisition(req({ satisfied: false, source: 'requisition' }))).toBe(true);
    expect(remediationOnRequisition(req({ satisfied: false, source: 'pipeline' }))).toBe(false);
    expect(remediationOnRequisition(req({ satisfied: true, source: 'requisition' }))).toBe(false);
  });
});

describe('present — isHistorical', () => {
  it('treats submitted/confirmed/revoked as read-only history', () => {
    expect(isHistorical('submitted_to_client')).toBe(true);
    expect(isHistorical('confirmed')).toBe(true);
    expect(isHistorical('revoked')).toBe(true);
    expect(isHistorical('ready_for_review')).toBe(false);
    expect(isHistorical('handoff_draft')).toBe(false);
  });
});
