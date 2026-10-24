import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button } from '@aramo/fe-foundation';
import { describe, expect, it, vi } from 'vitest';

import { AccessDenied } from './AccessDenied';
import { ConfirmDialog } from './ConfirmDialog';
import { FieldAck, FieldSelect, FieldText, FieldTextArea } from './ConfirmFields';
import { DetailDrawer } from './DetailDrawer';
import { LifecycleActionMenu } from './LifecycleActionMenu';
import { OneTimeSecret } from './OneTimeSecret';
import { TagInput } from './TagInput';
import { Timeline, shortId } from './Timeline';
import { TypedConfirm, typedConfirmMatches } from './TypedConfirm';

describe('ConfirmDialog (handoff §3.8)', () => {
  function Harness({ onCommit, error }: { onCommit: () => void; error?: string }) {
    const [open, setOpen] = useState(false);
    const [ack, setAck] = useState(false);
    const [reason, setReason] = useState('');
    return (
      <>
        <Button onClick={() => setOpen(true)}>Close tenant…</Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Close Calder Robotics"
          from={{ label: 'Offboarding', tone: 'muted' }}
          to={{ label: 'Closed', tone: 'muted' }}
          consequence="Closing is terminal."
          tone="danger"
          commitLabel="Close tenant"
          canCommit={ack && reason.length > 0}
          error={error}
          onCommit={onCommit}
        >
          <FieldSelect
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            options={[
              { value: '', label: 'Choose a reason', disabled: true },
              { value: 'owner_request', label: 'Owner request' },
            ]}
          />
          <FieldAck label="I understand closing is terminal and cannot be undone." checked={ack} onChange={setAck} />
        </ConfirmDialog>
      </>
    );
  }

  it('shows the Change box, consequence and fields; commit stays dim until valid', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close tenant…' }));
    const dialog = screen.getByRole('dialog', { name: 'Close Calder Robotics' });
    expect(dialog).toHaveTextContent('ChangeOffboarding→ to Closed');
    expect(screen.getByText('Closing is terminal.')).toBeInTheDocument();
    const commit = screen.getByRole('button', { name: 'Close tenant' });
    expect(commit).toBeDisabled();
    expect(commit.className).toContain('pw-btn--danger');
    expect(commit.className).toContain('pw-btn--dim');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'owner_request' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(commit).toBeEnabled();
    expect(commit.className).not.toContain('pw-btn--dim');
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('renders the commit error as an alert', () => {
    render(<Harness onCommit={vi.fn()} error="This change isn't allowed from Closed." />);
    fireEvent.click(screen.getByRole('button', { name: 'Close tenant…' }));
    expect(screen.getByRole('alert')).toHaveTextContent("This change isn't allowed from Closed.");
  });

  it('closes on Esc and returns focus to the opener', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Close tenant…' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

describe('ConfirmFields', () => {
  it('caps a textarea and shows the counter', () => {
    function T() {
      const [v, setV] = useState('');
      return <FieldTextArea label="Reason details" required max={5} value={v} onChange={setV} />;
    }
    render(<T />);
    fireEvent.change(screen.getByLabelText(/Reason details/), { target: { value: 'abcdefgh' } });
    expect(screen.getByLabelText(/Reason details/)).toHaveValue('abcde');
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
  });

  it('wires a text field label and helper', () => {
    render(<FieldText label="Close at" helper="UTC" value="" onChange={vi.fn()} type="date" />);
    expect(screen.getByLabelText('Close at')).toHaveAccessibleDescription('UTC');
  });
});

describe('TypedConfirm (handoff §9)', () => {
  it('matches trimmed, case-insensitively, and never on empty', () => {
    expect(typedConfirmMatches(' Ana@Aramo.ai ', 'ana@aramo.ai')).toBe(true);
    expect(typedConfirmMatches('ana@aramo.a', 'ana@aramo.ai')).toBe(false);
    expect(typedConfirmMatches('', '')).toBe(false);
  });

  it('renders a labelled mono input', () => {
    const onChange = vi.fn();
    render(<TypedConfirm label="Type the email to confirm" expected="ana@aramo.ai" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Type the email to confirm');
    expect(input.className).toContain('pw-input--typed');
    fireEvent.change(input, { target: { value: 'ana' } });
    expect(onChange).toHaveBeenCalledWith('ana');
  });
});

describe('TagInput', () => {
  function T({ initial = [] as string[] }) {
    const [tags, setTags] = useState<string[]>(initial);
    return <TagInput label="Products" tags={tags} onChange={setTags} max={2} />;
  }

  it('adds normalised tags on Enter, dedupes, caps and removes', () => {
    render(<T />);
    const input = screen.getByLabelText('Products');
    fireEvent.change(input, { target: { value: 'ats-1' } });
    expect(input).toHaveValue('ATS1');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'ats1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'sign' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'org' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove ATS1' }));
    expect(screen.queryByRole('button', { name: 'Remove ATS1' })).toBeNull();
  });

  it('removes the last tag on Backspace in an empty draft', () => {
    render(<T initial={['ATS', 'SIGN']} />);
    fireEvent.keyDown(screen.getByLabelText('Products'), { key: 'Backspace' });
    expect(screen.queryByRole('button', { name: 'Remove SIGN' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove ATS' })).toBeInTheDocument();
  });
});

describe('Timeline (handoff §6.3)', () => {
  it('renders label, from → to, reason + code, actor short id and the UTC stamp', () => {
    render(
      <Timeline
        now={new Date('2026-10-24T15:00:00Z')}
        events={[
          {
            id: 'e1',
            label: 'Suspended',
            at: '2026-10-11T13:20:00Z',
            tone: 'warn',
            from: { label: 'Active', tone: 'ok' },
            to: { label: 'Suspended', tone: 'warn' },
            reason: { label: 'Payment overdue', code: 'payment_overdue' },
            actor: { label: 'Operator', id: 'op_7f3a91c2e48b' },
            note: 'Invoice unpaid.',
          },
          { id: 'e2', label: 'Provisioned', at: '2026-10-02T10:12:00Z', actor: { label: 'System' } },
        ]}
      />,
    );
    const [first, second] = screen.getAllByRole('listitem');
    expect(first).toHaveTextContent('Suspended');
    expect(first).toHaveTextContent('Active→ to Suspended');
    expect(first).toHaveTextContent('11 Oct 2026 · 13 days ago');
    expect(first).toHaveTextContent('Payment overdue payment_overdue');
    expect(first).toHaveTextContent('Operator op_7f3a…');
    expect(screen.getByTitle('op_7f3a91c2e48b')).toBeInTheDocument();
    expect(first).toHaveTextContent('2026-10-11 13:20 UTC');
    expect(first).toHaveTextContent('Invoice unpaid.');
    expect(first?.querySelector('.pw-timeline__dot--warn')).not.toBeNull();
    expect(second?.querySelector('.pw-timeline__dot--faint')).not.toBeNull();
    expect(shortId('abc')).toBe('abc');
  });
});

describe('DetailDrawer (handoff §8.1)', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open row</Button>
        <DetailDrawer
          open={open}
          onOpenChange={setOpen}
          title="Odile Marchand"
          subtitle="odile@mail.com · pa_1"
          footer={<Button>Restrict…</Button>}
        >
          <p>Facts</p>
        </DetailDrawer>
      </>
    );
  }

  it('opens as a labelled dialog, traps focus inside, closes on Esc and returns focus', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open row' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole('dialog', { name: 'Odile Marchand' });
    expect(drawer).toHaveTextContent('odile@mail.com · pa_1');
    expect(drawer).toHaveTextContent('Facts');
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('closes from the × button', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('LifecycleActionMenu (handoff §6.3)', () => {
  const actions = [
    { key: 'suspend', label: 'Suspend', description: 'Blocks sign-in and freezes writes.' },
    { key: 'close', label: 'Close', description: 'Terminal.', tone: 'danger' as const },
  ];

  it('lists the passed actions with consequences and reports the choice', () => {
    const onSelect = vi.fn();
    render(<LifecycleActionMenu actions={actions} onSelect={onSelect} footnote="Becomes Active automatically." />);
    const trigger = screen.getByRole('button', { name: /Lifecycle actions/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveFocus();
    expect(items[1]).toHaveTextContent('CloseTerminal.');
    expect(items[1]?.querySelector('.pw-lcmenu__label--danger')).not.toBeNull();
    expect(screen.getByText('Becomes Active automatically.')).toBeInTheDocument();
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.click(items[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('close');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Esc and returns focus to the trigger', () => {
    render(<LifecycleActionMenu actions={actions} onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Lifecycle actions/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('OneTimeSecret (handoff §8.2)', () => {
  it('shows the code once with copy and dismiss', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn();
    const onDismiss = vi.fn();
    render(
      <OneTimeSecret
        secret="PILOT-7K2Q"
        recipient="ana@example.com"
        expires="7 Nov 2026"
        writeClipboard={write}
        onCopied={onCopied}
        onDismiss={onDismiss}
      />,
    );
    const card = screen.getByRole('status');
    expect(card).toHaveTextContent('This code is shown only once');
    expect(screen.getByTestId('one-time-secret')).toHaveTextContent('PILOT-7K2Q');
    expect(card).toHaveTextContent('For ana@example.comExpires 7 Nov 2026');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(write).toHaveBeenCalledWith('PILOT-7K2Q');
    expect(onCopied).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /I've saved it/ }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('AccessDenied (handoff §3.5)', () => {
  it('names the account, organization and missing permission, with both account buttons', () => {
    const onSwitch = vi.fn();
    const onSignOut = vi.fn();
    render(
      <AccessDenied
        what="Platform administration"
        explanation="You’re signed in with a tenant account."
        email="maya@northwind.com"
        organization="Northwind Logistics"
        permission={{ label: 'View tenants', code: 'platform:tenant:read' }}
        onSwitchAccount={onSwitch}
        onSignOut={onSignOut}
      />,
    );
    expect(screen.getByText('No access')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("This account can't open Platform administration");
    expect(screen.getByText('maya@northwind.com')).toBeInTheDocument();
    expect(screen.getByText('Northwind Logistics')).toBeInTheDocument();
    expect(screen.getByText('View tenants')).toBeInTheDocument();
    expect(screen.getByText('platform:tenant:read')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to dashboard' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a different account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSwitch).toHaveBeenCalled();
    expect(onSignOut).toHaveBeenCalled();
  });

  it('offers Back to dashboard only when given', () => {
    const onHome = vi.fn();
    render(
      <AccessDenied
        what="Registry"
        explanation="x"
        email="a"
        organization="b"
        permission={{ label: 'View skills', code: 'platform:skill:read' }}
        onSwitchAccount={vi.fn()}
        onSignOut={vi.fn()}
        onBackToDashboard={onHome}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to dashboard' }));
    expect(onHome).toHaveBeenCalled();
  });
});
