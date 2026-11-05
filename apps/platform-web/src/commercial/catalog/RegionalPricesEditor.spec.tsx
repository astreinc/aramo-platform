import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RegionalPricesEditor } from './RegionalPricesEditor';
import { formatRegionalPrice, parseRegionalPriceInput, regionalRows } from './regional-prices-model';
import { TERMS, v } from './catalog-test-data';

// Sign Mobile M-A12 Amendment A1-3 — the admin.aramo.ai regional price editor and display: every
// viewer sees the version's regional prices (e.g. IN / INR); only a catalog manager edits, and only a
// DRAFT (a published version's prices are immutable: a change is a new version, Finance → Owner).

const IN_M = { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' as const };
const IN_Y = { country: 'IN', currency: 'INR', amount_minor: 899900, interval: 'YEAR' as const };

describe('M-A12 A1-3 — regional price model', () => {
  it('formats in the currency’s minor units', () => {
    expect(formatRegionalPrice(IN_M)).toBe('899.00 INR / month');
    expect(formatRegionalPrice({ country: 'JP', currency: 'JPY', amount_minor: 1500, interval: 'YEAR' })).toBe('1500 JPY / year');
  });
  it('parses the add form (fails closed): country, currency, never US, decimals per currency', () => {
    expect(parseRegionalPriceInput({ country: 'in', currency: 'inr', interval: 'MONTH', amount: '899' })).toEqual({ ok: true, edit: { country: 'IN', currency: 'INR', interval: 'MONTH', amount_minor: 89900 } });
    expect(parseRegionalPriceInput({ country: 'IN', currency: 'INR', interval: 'YEAR', amount: '8999.50' })).toMatchObject({ ok: true, edit: { amount_minor: 899950 } });
    expect(parseRegionalPriceInput({ country: 'US', currency: 'USD', interval: 'MONTH', amount: '10' }).ok).toBe(false);
    expect(parseRegionalPriceInput({ country: 'IND', currency: 'INR', interval: 'MONTH', amount: '1' }).ok).toBe(false);
    expect(parseRegionalPriceInput({ country: 'IN', currency: 'RS', interval: 'MONTH', amount: '1' }).ok).toBe(false);
    expect(parseRegionalPriceInput({ country: 'JP', currency: 'JPY', interval: 'MONTH', amount: '1.5' }).ok).toBe(false);
    expect(parseRegionalPriceInput({ country: 'IN', currency: 'INR', interval: 'MONTH', amount: '-1' }).ok).toBe(false);
  });
  it('sorts by country then MONTH before YEAR', () => {
    expect(regionalRows([IN_Y, { ...IN_M, country: 'BR', currency: 'BRL' }, IN_M]).map((r) => `${r.country}:${r.interval}`)).toEqual(['BR:MONTH', 'IN:MONTH', 'IN:YEAR']);
  });
});

describe('M-A12 A1-3 — RegionalPricesEditor', () => {
  it('a PUBLISHED version shows its prices read-only (no form, no remove)', () => {
    render(<RegionalPricesEditor version={v({ id: 'p', version_number: 2, status: 'PUBLISHED', terms: { ...TERMS, regional_prices: [IN_Y, IN_M] } })} canDraft onSave={vi.fn()} />);
    expect(screen.getByText('899.00 INR / month')).toBeTruthy();
    expect(screen.getByText('8999.00 INR / year')).toBeTruthy();
    expect(screen.queryByTestId('regional-price-form')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('a viewer without draft authority never sees the form, even on a DRAFT', () => {
    render(<RegionalPricesEditor version={v({ id: 'd', version_number: 3, status: 'DRAFT', terms: { ...TERMS } })} canDraft={false} onSave={vi.fn()} />);
    expect(screen.getByTestId('regional-prices-empty')).toBeTruthy();
    expect(screen.queryByTestId('regional-price-form')).toBeNull();
  });

  it('a catalog manager sets an IN / INR monthly price and removes one on a DRAFT', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<RegionalPricesEditor version={v({ id: 'd', version_number: 3, status: 'DRAFT', terms: { ...TERMS, regional_prices: [IN_Y] } })} canDraft onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Regional price country'), { target: { value: 'in' } });
    fireEvent.change(screen.getByLabelText('Regional price currency'), { target: { value: 'inr' } });
    fireEvent.change(screen.getByLabelText('Regional price amount'), { target: { value: '899' } });
    fireEvent.click(screen.getByText('Set price'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ country: 'IN', currency: 'INR', interval: 'MONTH', amount_minor: 89900 }]));
    fireEvent.click(screen.getByLabelText('Remove the IN annual price'));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith([{ country: 'IN', interval: 'YEAR', currency: 'INR', amount_minor: null }]));
  });

  it('an invalid entry shows the reason and saves nothing', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<RegionalPricesEditor version={v({ id: 'd', version_number: 3, status: 'DRAFT', terms: { ...TERMS } })} canDraft onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Regional price country'), { target: { value: 'US' } });
    fireEvent.change(screen.getByLabelText('Regional price currency'), { target: { value: 'USD' } });
    fireEvent.change(screen.getByLabelText('Regional price amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByText('Set price'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/US price is the plan’s list price/);
    expect(onSave).not.toHaveBeenCalled();
  });
});
