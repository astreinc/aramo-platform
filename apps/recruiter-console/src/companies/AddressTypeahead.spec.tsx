import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddressTypeahead } from './AddressTypeahead';
import * as api from './companies-api';
import type { AddressDetails } from './types';

// Address-Autocomplete v1.0 — the async typeahead specs. Covers the ≥3-char
// debounce gate, suggestion render, select→details→populate, and the
// NEVER-BLOCK soft-fail (a provider error surfaces a manual-entry notice and
// never calls onSelectAddress / never throws).

const GOOGLEPLEX: AddressDetails = {
  place_id: 'gpid-1',
  provider: 'google',
  address: '1600 Amphitheatre Pkwy',
  address2: null,
  city: 'Mountain View',
  state: 'CA',
  zip: '94043',
  country: 'US',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AddressTypeahead', () => {
  it('does NOT call autocomplete for a query under 3 characters', async () => {
    const spy = vi.spyOn(api, 'autocompleteAddress');
    render(<AddressTypeahead onSelectAddress={vi.fn()} testId="ta" />);
    fireEvent.change(screen.getByTestId('ta'), { target: { value: 'ab' } });
    // Give any debounce a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it('queries (debounced) for ≥3 chars and renders suggestions', async () => {
    vi.spyOn(api, 'autocompleteAddress').mockResolvedValue({
      suggestions: [
        {
          place_id: 'gpid-1',
          description: '1600 Amphitheatre Pkwy, Mountain View, CA',
          primary_text: '1600 Amphitheatre Pkwy',
          secondary_text: 'Mountain View, CA',
        },
      ],
    });
    render(<AddressTypeahead onSelectAddress={vi.fn()} testId="ta" />);
    fireEvent.change(screen.getByTestId('ta'), { target: { value: '1600 amph' } });
    expect(await screen.findByText('1600 Amphitheatre Pkwy')).toBeInTheDocument();
  });

  it('on select, resolves details and calls onSelectAddress with the structured fields', async () => {
    vi.spyOn(api, 'autocompleteAddress').mockResolvedValue({
      suggestions: [
        {
          place_id: 'gpid-1',
          description: '1600 Amphitheatre Pkwy, Mountain View, CA',
          primary_text: '1600 Amphitheatre Pkwy',
          secondary_text: 'Mountain View, CA',
        },
      ],
    });
    const detailsSpy = vi
      .spyOn(api, 'getAddressDetails')
      .mockResolvedValue({ details: GOOGLEPLEX });
    const onSelect = vi.fn();
    render(<AddressTypeahead onSelectAddress={onSelect} testId="ta" />);
    fireEvent.change(screen.getByTestId('ta'), { target: { value: '1600 amph' } });
    fireEvent.click(await screen.findByTestId('ta-option-gpid-1'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(GOOGLEPLEX));
    expect(detailsSpy).toHaveBeenCalledWith('gpid-1');
  });

  it('NEVER-BLOCK: a provider autocomplete failure shows a manual-entry notice and does not throw', async () => {
    vi.spyOn(api, 'autocompleteAddress').mockRejectedValue(new Error('boom'));
    const onSelect = vi.fn();
    render(<AddressTypeahead onSelectAddress={onSelect} testId="ta" />);
    fireEvent.change(screen.getByTestId('ta'), { target: { value: 'anywhere' } });
    expect(await screen.findByText(/enter the address manually/i)).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('NEVER-BLOCK: null details (provider couldn’t resolve) does not call onSelectAddress', async () => {
    vi.spyOn(api, 'autocompleteAddress').mockResolvedValue({
      suggestions: [
        {
          place_id: 'gpid-x',
          description: 'Somewhere',
          primary_text: 'Somewhere',
          secondary_text: '',
        },
      ],
    });
    vi.spyOn(api, 'getAddressDetails').mockResolvedValue({ details: null });
    const onSelect = vi.fn();
    render(<AddressTypeahead onSelectAddress={onSelect} testId="ta" />);
    fireEvent.change(screen.getByTestId('ta'), { target: { value: 'somewhere' } });
    fireEvent.click(await screen.findByTestId('ta-option-gpid-x'));
    await waitFor(() =>
      expect(screen.getByText(/enter the address manually/i)).toBeInTheDocument(),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
