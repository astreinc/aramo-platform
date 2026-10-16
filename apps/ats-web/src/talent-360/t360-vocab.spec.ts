import { describe, expect, it } from 'vitest';

import {
  availabilityLabel,
  channelLabel,
  dispositionReasonLabel,
  engagementLabel,
  journeyOwnerLabel,
  workHistorySourceLabel,
} from './t360-vocab';

describe('t360-vocab — codes never reach the screen raw', () => {
  it('maps closed vocabularies through their canonical labels', () => {
    expect(availabilityLabel('available_now')).toBe('Available now');
    expect(engagementLabel('contract_to_hire')).toBe('Contract-to-hire');
    expect(dispositionReasonLabel('talent_accepted_other_role')).toBe('Talent accepted another role');
    expect(journeyOwnerLabel('client-selection')).toBe('Client selection');
    expect(channelLabel('voice')).toBe('Call');
    expect(workHistorySourceLabel('resume')).toBe('From resume');
  });

  it('falls back to readable sentence case for an unknown code', () => {
    expect(dispositionReasonLabel('some_new_reason')).toBe('Some new reason');
    expect(workHistorySourceLabel('partner_feed')).toBe('External profile');
  });
});
