import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RequisitionHoldBanner, presentHold } from './hold-details';
import type { RequisitionHold } from './types';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.4 (S3, A1 AM-3 §4) — the On hold
// banner never invents a value.
const base: RequisitionHold = {
  recorded: true,
  reason: 'Client hiring temporarily paused',
  reason_provided: true,
  source: 'client',
  effective_at: '2026-10-21T00:00:00.000Z',
  instructions: 'Keep qualifying; no client submittals.',
  provider_status: null,
};

describe('presentHold / RequisitionHoldBanner (v1.2 §6.4)', () => {
  it('a manual hold shows its reason, source, date and Account Manager instructions', () => {
    render(<RequisitionHoldBanner hold={base} />);
    expect(screen.getByText(/Client hiring temporarily paused/)).toBeTruthy();
    expect(screen.getByText(/Source: Client/)).toBeTruthy();
    expect(screen.getByText(/Account Manager instructions: Keep qualifying/)).toBeTruthy();
    expect(screen.getByText(/Recruiting and qualification may continue/)).toBeTruthy();
  });

  it('a VMS hold with no reason reads "Reason not provided by VMS", plus the provider status when known', () => {
    const vms = { ...base, reason: null, reason_provided: false, source: 'vms' as const, instructions: null };
    expect(presentHold(vms).reasonLine).toBe('Reason not provided by VMS');
    expect(presentHold({ ...vms, provider_status: 'Halted' }).reasonLine).toBe(
      'Reason not provided by VMS (VMS status: Halted)',
    );
    expect(presentHold(vms).sourceLabel).toBe('VMS');
  });

  it('a hold placed before the amendment reads "not recorded"', () => {
    const legacy: RequisitionHold = {
      recorded: false,
      reason: null,
      reason_provided: false,
      source: null,
      effective_at: null,
      instructions: null,
      provider_status: null,
    };
    expect(presentHold(legacy)).toEqual({
      reasonLine: 'Hold details not recorded',
      sourceLabel: null,
      effectiveLabel: null,
      instructions: null,
    });
    expect(presentHold(undefined).reasonLine).toBe('Hold details not recorded');
  });
});
