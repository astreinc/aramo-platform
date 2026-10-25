import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExceptionOverlay } from './ExceptionOverlay';
import { SupportField, SupportRequestDialog } from './SupportRequestDialog';

// CCP-B6 (directive R-3: each NEW component has typed props and tests) — ExceptionOverlay and
// SupportRequestDialog.

describe('CCP-B6 ExceptionOverlay', () => {
  it('an exception carries the EXCEPTION text tag (colour is never the only cue), the title, the reference and every row', () => {
    render(<ExceptionOverlay exception title="+10 day support extension · applied with zero approvals" reference="EXT-0042" rows={[{ label: 'Actor', value: 'Kwame Mensah · 2026-10-03 16:40 UTC' }, { label: 'Stripe billing', value: 'Overlay only — Stripe period and invoices unchanged' }]} />);
    const card = screen.getByRole('region', { name: 'Exception: +10 day support extension · applied with zero approvals' });
    expect(within(card).getByText('EXCEPTION')).toBeInTheDocument();
    expect(within(card).getByText('EXT-0042')).toBeInTheDocument();
    expect(within(card).getByText('Actor').tagName).toBe('DT');
    expect(within(card).getByText('Overlay only — Stripe period and invoices unchanged').tagName).toBe('DD');
  });

  it('an approved extension has no EXCEPTION tag and the neutral frame', () => {
    const { container } = render(<ExceptionOverlay exception={false} title="+20 day support extension · approved through a change request" reference="EXT-1" rows={[]} />);
    expect(screen.queryByText('EXCEPTION')).toBeNull();
    expect(container.querySelector('.pw-xo--approved')).not.toBeNull();
  });
});

describe('CCP-B6 SupportRequestDialog', () => {
  it('renders the fields, the preview as role=status, the chain strip and the alert; commit is dimmed and inert until valid', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <SupportRequestDialog
        open
        onOpenChange={() => undefined}
        title="Request support extension · Fernhill Studio"
        sub="Extends access as an overlay."
        preview={{ tone: 'warn', title: 'Out of bounds — escalates to approval (Finance)', lines: ['More than 14 days in one extension.'] }}
        chain={{ label: 'Below threshold', steps: ['Finance'], policy: 'v1', window: '72 h' }}
        alert="Refused. (409 X)"
        commitLabel="Submit for approval"
        tone="terra"
        canCommit={false}
        onCommit={onCommit}
      >
        <SupportField kind="number" label="Extension (days)" value="20" onChange={() => undefined} help="Policy v1." />
      </SupportRequestDialog>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
    expect(within(dlg).getByLabelText('Extension (days)')).toHaveAccessibleDescription('Policy v1.');
    expect(within(dlg).getByRole('status')).toHaveTextContent('Out of bounds — escalates to approval (Finance)More than 14 days in one extension.');
    expect(within(dlg).getByTestId('chain-preview')).toHaveTextContent('Approval chainBelow thresholdFinancepolicy v1 · 72 h window');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Refused. (409 X)');
    const commit = within(dlg).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    expect(commit.className).toContain('pw-sxd__btn--dim');
    expect(commit.className).toContain('pw-sxd__btn--terra');
    rerender(
      <SupportRequestDialog open onOpenChange={() => undefined} title="T" sub="S" commitLabel="Go" tone="danger" canCommit onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
