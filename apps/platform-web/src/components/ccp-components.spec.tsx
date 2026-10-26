import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AccessDenied } from './AccessDenied';
import { ApprovalChain, ChainProgress } from './ApprovalChain';
import { BeforeAfterDiff } from './BeforeAfterDiff';
import { BootstrapBanner } from './BootstrapBanner';
import { CrStepper } from './CrStepper';
import { EligibilityVerdict, RosterVerdicts } from './EligibilityVerdict';
import { EmptyState } from './EmptyState';

// CCP-B1 — the NEW CCP components (CCP-UI v1.0 handoff §6; PLATFORM-UX-1 R-3: each
// has typed props and tests) and the additive variants on existing components.

describe('CrStepper', () => {
  it('is an ordered list named "Request state" with marks and hidden state text', () => {
    render(
      <CrStepper
        steps={[
          { label: 'Draft', mark: 'done' },
          { label: 'Pending approval', mark: 'failed' },
          { label: 'Approved', mark: 'todo', dim: true },
          { label: 'Rejected', mark: 'terminal' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Request state' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['✓Draft (done)', '✕Pending approval (stopped here)', '○Approved (not reached)', '■Rejected (final state)']);
    expect(items[2]).toHaveClass('pw-crstep__chip--dim');
  });
  it('marks the current chip aria-current="step"', () => {
    render(<CrStepper steps={[{ label: 'Draft', mark: 'done' }, { label: 'Pending approval', mark: 'current' }]} />);
    expect(screen.getByText('Pending approval').closest('li')).toHaveAttribute('aria-current', 'step');
  });
});

describe('ApprovalChain / ChainProgress', () => {
  it('one row per step: badge, title, who', () => {
    render(
      <ApprovalChain
        steps={[
          { key: '0', number: 1, title: 'Finance · Finance admin', who: 'Signed by Priya Shah · 2026-10-24 10:00 UTC', state: 'signed' },
          { key: '1', number: 2, title: 'Owner · Platform owner', who: 'Waiting', state: 'current' },
        ]}
      />,
    );
    const rows = within(screen.getByRole('list', { name: 'Approval chain' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('✓Finance · Finance adminSigned by Priya Shah');
    expect(rows[1]).toHaveTextContent('2Owner · Platform ownerWaiting');
  });
  it('inline progress: "Finance ✓ › Owner ○" with hidden signed text', () => {
    const { container } = render(<ChainProgress steps={[{ label: 'Finance', signed: true }, { label: 'Owner', signed: false }]} />);
    expect(container.textContent).toBe('Finance ✓ signed›Owner ○ not signed');
  });
});

describe('EligibilityVerdict / RosterVerdicts', () => {
  it('OK box and refusal box', () => {
    const { rerender } = render(<EligibilityVerdict ok label="You can sign the Finance step" why="Approving records your name." />);
    expect(screen.getByTestId('eligibility-verdict')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('eligibility-verdict')).toHaveTextContent('Your eligibility✓ You can sign the Finance step');
    rerender(<EligibilityVerdict ok={false} label="You already approved a step" why="One person can sign only one step." />);
    expect(screen.getByTestId('eligibility-verdict')).toHaveTextContent('— You can’t approve: You already approved a step');
  });
  it('the roster list, or its designed empty line', () => {
    const { rerender } = render(<RosterVerdicts step="Finance" entries={null} emptyText="Not available." />);
    expect(screen.getByText('Who can sign the Finance step')).toBeInTheDocument();
    expect(screen.getByTestId('roster-empty')).toHaveTextContent('Not available.');
    rerender(<RosterVerdicts step="Finance" emptyText="x" entries={[{ key: 'a', name: 'Arjun Rao', roles: 'Finance admin', ok: true, label: 'Can sign' }]} />);
    expect(screen.getByText('Can sign')).toBeInTheDocument();
  });
});

describe('BeforeAfterDiff', () => {
  it('three columns; an unrecorded before is "—" and not struck', () => {
    render(
      <BeforeAfterDiff
        rows={[
          { key: 'a', field: 'Account credit', before: null, after: '$350' },
          { key: 'b', field: 'Role', before: 'Not held', after: 'Held' },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Effect, before and after' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Account creditBefore: not recorded on the request —After: $350');
    expect((items[1] as HTMLElement).querySelector('.pw-badiff__before')).toHaveTextContent('Before: Not held');
  });
});

describe('BootstrapBanner', () => {
  it('renders nothing without chains; role=alert with the chains and the 409', () => {
    const { container, rerender } = render(<BootstrapBanner chains={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BootstrapBanner chains={['Above threshold (Finance → Owner)', 'Catalog publish (Finance → Owner)']} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Commercial approvals unavailable: not enough distinct approvers for Above threshold (Finance → Owner), Catalog publish (Finance → Owner).Approvals on these chains return 409 CCP_NOT_BOOTSTRAPPED.',
    );
  });
});

describe('additive variants (existing components unchanged by default)', () => {
  it('AccessDenied ccp: Current role, Grants access chips, footnote; Missing and Sign out kept (R-5)', () => {
    render(
      <AccessDenied
        variant="ccp"
        what="Commercial approvals"
        explanation="why"
        email="maya.okafor@aramo.ai"
        role="Super admin"
        grants={['Platform owner', 'Finance admin']}
        permission={{ label: 'View commercial change requests', code: 'platform:approval:read' }}
        footnote="foot"
        onSwitchAccount={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    const d = screen.getByTestId('access-denied');
    expect(d).toHaveClass('pw-denied--ccp');
    expect(within(d).queryByText('Organization')).toBeNull();
    expect(within(d).getByText('Current role').nextSibling).toHaveTextContent('Super admin');
    expect(within(d).getByText('Grants access').nextSibling).toHaveTextContent('Platform ownerFinance admin');
    expect(within(d).getByText('platform:approval:read')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(d).getByText('foot')).toBeInTheDocument();
  });
  it('AccessDenied default keeps the Organization row and the default footnote', () => {
    render(<AccessDenied what="x" explanation="y" email="e" organization="Aramo Platform" permission={{ label: 'l', code: 'c' }} onSwitchAccount={vi.fn()} onSignOut={vi.fn()} />);
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.queryByText('Current role')).toBeNull();
    expect(screen.getByText(/Platform administration needs an Aramo staff account\. If you were signed in to a tenant app in another tab, that session may have been reused here\./)).toBeInTheDocument();
  });
  it('EmptyState xl', () => {
    const { container } = render(<EmptyState size="xl" title="Nothing waiting on you" body="b" />);
    expect(container.firstChild).toHaveClass('pw-empty', 'pw-empty--xl');
  });
});
