import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChainPreview } from './ChainPreview';
import { CommercialRequestDialog, RequestField, typedTokenMatches } from './CommercialRequestDialog';

// CCP-B2 — the NEW commercial components (directive R-3: typed props and tests).

describe('ChainPreview', () => {
  it('renders the chain strip, and the not-fulfillable suffix while bootstrapping', () => {
    const { rerender } = render(<ChainPreview label="Catalog publish" steps={['Finance', 'Owner']} policy="v1" window="72 h" />);
    expect(screen.getByTestId('chain-preview')).toHaveTextContent('Approval chainCatalog publishFinance → Ownerpolicy v1 · 72 h window');
    rerender(<ChainPreview label="Catalog publish" steps={['Finance', 'Owner']} policy="v1" window="72 h" notFulfillable />);
    expect(screen.getByTestId('chain-preview')).toHaveTextContent('Finance → Owner · not fulfillable yet');
  });
});

function Harness({ onCommit, typedToken }: { onCommit: () => void; typedToken?: string }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  return (
    <CommercialRequestDialog
      open
      onOpenChange={() => undefined}
      title="Request retire · Sign Team v2"
      sub="Retired versions take no new subscriptions."
      diff={[{ field: 'Sign Team v2', before: 'Published', after: 'Retired', changed: true }]}
      chain={<ChainPreview label="Catalog publish" steps={['Finance', 'Owner']} policy="v1" window="72 h" />}
      typed={typedToken ? { token: typedToken, value: typed, onChange: setTyped } : null}
      alert={null}
      commitLabel="Submit for approval"
      tone="danger"
      canCommit={reason.length > 0}
      onCommit={onCommit}
    >
      <RequestField label="Reason" value={reason} onChange={setReason} placeholder="Why this change is needed" multiline />
    </CommercialRequestDialog>
  );
}

describe('CommercialRequestDialog', () => {
  it('commit stays disabled until the request is complete and the typed token matches exactly', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} typedToken="Team v2" />);
    const dialog = screen.getByRole('dialog', { name: 'Request retire · Sign Team v2' });
    expect(within(dialog).getByText('Retired versions take no new subscriptions.')).toBeInTheDocument();
    expect(within(dialog).getByText('Before → after')).toBeInTheDocument();
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'x' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'team v2' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Team v2' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('typedTokenMatches is exact', () => {
    expect(typedTokenMatches('Team v2', 'Team v2')).toBe(true);
    expect(typedTokenMatches(' Team v2', 'Team v2')).toBe(false);
    expect(typedTokenMatches('', '')).toBe(false);
  });
});
