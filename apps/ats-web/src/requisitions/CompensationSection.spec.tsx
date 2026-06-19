import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CompensationSection,
  emptyCompensationFormState,
  type CompensationFormState,
} from './CompensationSection';

function renderWith(args: {
  scopes: readonly string[];
  initial?: Partial<CompensationFormState>;
  onChange?: (next: CompensationFormState) => void;
}) {
  const value = { ...emptyCompensationFormState(), ...args.initial };
  const onChange = args.onChange ?? vi.fn();
  return render(
    <CompensationSection
      value={value}
      onChange={onChange}
      scopes={args.scopes}
    />,
  );
}

describe('CompensationSection — D5 defensive FE (ruling 1)', () => {
  it('renders NOTHING when the actor holds zero compensation:view:* scopes', () => {
    const { container } = renderWith({ scopes: ['requisition:create'] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the discriminator when the actor holds any compensation:view scope', () => {
    renderWith({ scopes: ['compensation:view:bill'] });
    expect(screen.getByText('Compensation')).toBeInTheDocument();
    expect(screen.getByLabelText('Not specified')).toBeInTheDocument();
    expect(screen.getByLabelText('Contract')).toBeInTheDocument();
    expect(screen.getByLabelText('Permanent')).toBeInTheDocument();
  });

  it('with only compensation:view:bill, CONTRACT discriminator shows ONLY the bill rate group (no pay rate)', () => {
    renderWith({
      scopes: ['compensation:view:bill'],
      initial: { compensation_model: 'CONTRACT' },
    });
    expect(screen.getByText('Bill rate')).toBeInTheDocument();
    expect(screen.queryByText('Pay rate')).toBeNull();
  });

  it('with only compensation:view:pay, CONTRACT discriminator shows ONLY the pay rate group (no bill rate)', () => {
    renderWith({
      scopes: ['compensation:view:pay'],
      initial: { compensation_model: 'CONTRACT' },
    });
    expect(screen.getByText('Pay rate')).toBeInTheDocument();
    expect(screen.queryByText('Bill rate')).toBeNull();
  });

  it('with compensation:view:pay AND compensation:view:bill, CONTRACT shows BOTH rate groups', () => {
    renderWith({
      scopes: ['compensation:view:pay', 'compensation:view:bill'],
      initial: { compensation_model: 'CONTRACT' },
    });
    expect(screen.getByText('Pay rate')).toBeInTheDocument();
    expect(screen.getByText('Bill rate')).toBeInTheDocument();
  });

  it('with compensation:view:pay AND compensation:view:bill, PERMANENT shows salary + placement fee', () => {
    renderWith({
      scopes: ['compensation:view:pay', 'compensation:view:bill'],
      initial: { compensation_model: 'PERMANENT' },
    });
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('Placement fee')).toBeInTheDocument();
  });

  it('with only compensation:view:revenue (bill_rate-only subset), CONTRACT shows ONLY bill rate (not placement fee under PERMANENT)', () => {
    renderWith({
      scopes: ['compensation:view:revenue'],
      initial: { compensation_model: 'CONTRACT' },
    });
    expect(screen.getByText('Bill rate')).toBeInTheDocument();
  });

  it('with only compensation:view:revenue, PERMANENT shows nothing on the branch (revenue maps to bill_rate, no PERMANENT-side fields)', () => {
    renderWith({
      scopes: ['compensation:view:revenue'],
      initial: { compensation_model: 'PERMANENT' },
    });
    expect(screen.queryByText('Salary')).toBeNull();
    expect(screen.queryByText('Placement fee')).toBeNull();
  });
});

describe('CompensationSection — discriminator UX (ruling 2 Option A: hide off-branch, no auto-clear)', () => {
  it('CONTRACT does NOT render any PERMANENT-side fields (off-branch hidden)', () => {
    renderWith({
      scopes: ['compensation:view:pay', 'compensation:view:bill'],
      initial: { compensation_model: 'CONTRACT' },
    });
    expect(screen.queryByText('Salary')).toBeNull();
    expect(screen.queryByText('Placement fee')).toBeNull();
  });

  it('PERMANENT does NOT render any CONTRACT-side fields (off-branch hidden)', () => {
    renderWith({
      scopes: ['compensation:view:pay', 'compensation:view:bill'],
      initial: { compensation_model: 'PERMANENT' },
    });
    expect(screen.queryByText('Pay rate')).toBeNull();
    expect(screen.queryByText('Bill rate')).toBeNull();
  });

  it('selecting a discriminator emits onChange with the new model; does NOT clear off-branch values (no auto-clear)', () => {
    const onChange = vi.fn();
    renderWith({
      scopes: ['compensation:view:pay', 'compensation:view:bill'],
      initial: {
        compensation_model: 'CONTRACT',
        pay_rate_amount: '60.00',
        pay_rate_currency: 'USD',
      },
      onChange,
    });
    fireEvent.click(screen.getByLabelText('Permanent'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as CompensationFormState;
    expect(next.compensation_model).toBe('PERMANENT');
    // Off-branch values preserved in state (NO auto-clear) — ruling 2:
    // discriminator change is labeling intent, not delete intent.
    expect(next.pay_rate_amount).toBe('60.00');
    expect(next.pay_rate_currency).toBe('USD');
  });
});

describe('CompensationSection — money inputs (decimal-as-string, NOT type=number)', () => {
  it('the pay-rate amount input is type=text with inputMode=decimal and the DECIMAL_RE pattern', () => {
    renderWith({
      scopes: ['compensation:view:pay'],
      initial: { compensation_model: 'CONTRACT' },
    });
    const input = screen.getByLabelText('Pay rate amount') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('decimal');
    expect(input.pattern).toBe('^\\d{1,12}(?:\\.\\d{1,4})?$');
  });

  it('the salary amount input is type=text with inputMode=decimal (no float)', () => {
    renderWith({
      scopes: ['compensation:view:pay'],
      initial: { compensation_model: 'PERMANENT' },
    });
    const input = screen.getByLabelText('Salary amount') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('decimal');
  });

  it('typing into an amount emits onChange with the raw string (precision preserved)', () => {
    const onChange = vi.fn();
    renderWith({
      scopes: ['compensation:view:pay'],
      initial: { compensation_model: 'CONTRACT' },
      onChange,
    });
    fireEvent.change(screen.getByLabelText('Pay rate amount'), {
      target: { value: '33.3333' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ pay_rate_amount: '33.3333' }),
    );
  });
});
