import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HydratedFieldValue } from './HydratedFieldValue';
import type { ProfileHydrationItem } from './profile-hydration';

function item(over: Partial<ProfileHydrationItem> & { field_key: string }): ProfileHydrationItem {
  return {
    current_value: null,
    value_state: 'UNKNOWN',
    source_type: null,
    projection_policy: 'AUTO',
    provenance: null,
    resolution_status: 'NONE',
    resolution_reason: null,
    proposed_value: null,
    ...over,
  };
}

describe('HydratedFieldValue — renders server hydration state (TI-1E-B1)', () => {
  it('SET → the typed value, no cleared/review, no chip when source_type null', () => {
    render(<HydratedFieldValue item={item({ field_key: 'desired_pay', value_state: 'SET', current_value: '$85/hr' })} />);
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('$85/hr');
    expect(screen.queryByTestId('hydrated-cleared')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hydrated-provenance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hydrated-review')).not.toBeInTheDocument();
  });

  it('UNKNOWN → em-dash, no Cleared badge (distinct from cleared)', () => {
    render(<HydratedFieldValue item={item({ field_key: 'notes', value_state: 'UNKNOWN' })} />);
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('—');
    expect(screen.queryByTestId('hydrated-cleared')).not.toBeInTheDocument();
  });

  it('EXPLICITLY_CLEARED → em-dash + a "Cleared" badge', () => {
    render(<HydratedFieldValue item={item({ field_key: 'work_authorization', value_state: 'EXPLICITLY_CLEARED' })} />);
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('—');
    expect(screen.getByTestId('hydrated-cleared')).toHaveTextContent('Cleared');
  });

  it('source_type RECONCILED → a provenance chip (server-driven); null → none', () => {
    const { rerender } = render(
      <HydratedFieldValue item={item({ field_key: 'city', value_state: 'SET', current_value: 'London', source_type: 'RECONCILED', provenance: { evidence_id: 'e1' } })} />,
    );
    expect(screen.getByTestId('hydrated-provenance')).toBeInTheDocument();
    rerender(<HydratedFieldValue item={item({ field_key: 'city', value_state: 'SET', current_value: 'London', source_type: null })} />);
    expect(screen.queryByTestId('hydrated-provenance')).not.toBeInTheDocument();
  });

  it('PENDING_REVIEW → a "Review required" affordance surfacing the proposed value', () => {
    render(
      <HydratedFieldValue
        item={item({ field_key: 'work_authorization', value_state: 'EXPLICITLY_CLEARED', resolution_status: 'PENDING_REVIEW', resolution_reason: 'EVIDENCE_CONFLICT', proposed_value: 'US_CITIZEN' })}
      />,
    );
    const review = screen.getByTestId('hydrated-review');
    expect(review).toHaveTextContent('Review required');
    expect(review).toHaveTextContent('US_CITIZEN');
  });

  it('boolean SET renders typed (Yes), never "true"', () => {
    render(<HydratedFieldValue item={item({ field_key: 'can_relocate', value_state: 'SET', current_value: true })} />);
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('Yes');
    expect(screen.getByTestId('hydrated-value')).not.toHaveTextContent('true');
  });

  it('undefined item (hydration absent) → the fallback text', () => {
    render(<HydratedFieldValue item={undefined} fallback="Austin" />);
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('Austin');
  });

  it('formatValue maps a SET enum raw value to its human label', () => {
    render(
      <HydratedFieldValue
        item={item({ field_key: 'work_authorization', value_state: 'SET', current_value: 'us_citizen' })}
        formatValue={(v) => (v === 'us_citizen' ? 'US Citizen' : String(v))}
      />,
    );
    expect(screen.getByTestId('hydrated-value')).toHaveTextContent('US Citizen');
  });
});
