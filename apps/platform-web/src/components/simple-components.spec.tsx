import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffView } from './DiffView';
import { EmptyState } from './EmptyState';
import { EnvironmentBar } from './EnvironmentBar';
import { FilterBar } from './FilterBar';
import { Skeleton, SkeletonPanel } from './Skeleton';
import { Stepper } from './Stepper';
import { ViewOnlyNote } from './ViewOnlyNote';

describe('EnvironmentBar (handoff §3.2)', () => {
  it('names the console and the signed-in identity', () => {
    render(<EnvironmentBar email="maya.okafor@aramo.ai" tenant="Aramo Platform" role="Super admin" />);
    expect(screen.getByRole('banner')).toHaveTextContent('PLATFORM ADMIN');
    expect(screen.getByText('admin.aramo.ai · actions here apply across every tenant')).toBeInTheDocument();
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent(
      'Signed in as maya.okafor@aramo.ai · Aramo Platform · Super admin',
    );
  });

  it('omits the role while unresolved and swaps the Studio line', () => {
    render(<EnvironmentBar email="sub-1" tenant="tenant-1" context="studio" />);
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent('Signed in as sub-1 · tenant-1');
    expect(screen.getByTestId('envbar-identity').textContent).not.toContain('· null');
    expect(screen.getByText('Template changes apply to every tenant that uses the default')).toBeInTheDocument();
  });
});

describe('FilterBar (handoff §3.6)', () => {
  it('renders segmented toggles with counts and reports a change', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        label="Status"
        options={[
          { value: 'ALL', label: 'All', count: 11 },
          { value: 'ACTIVE', label: 'Active', count: 4 },
        ]}
        value="ALL"
        onChange={onChange}
        resultCount="11 tenants"
      />,
    );
    const all = screen.getByRole('button', { name: /All/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Active/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('group', { name: 'Status' })).toHaveTextContent('All11Active4');
    fireEvent.click(screen.getByRole('button', { name: /Active/ }));
    expect(onChange).toHaveBeenCalledWith('ACTIVE');
    expect(screen.getByText('11 tenants')).toBeInTheDocument();
  });
});

describe('ViewOnlyNote (handoff §3.6)', () => {
  it('names the permission the change needs', () => {
    render(<ViewOnlyNote permission="Manage skills" />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'View only.You can view this. Changing it needs the Manage skills permission.',
    );
  });

  it('accepts a subject and change phrase', () => {
    render(<ViewOnlyNote permission="Manage tenant lifecycle" subject="this tenant" needs="Lifecycle and domain changes need" />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'You can view this tenant. Lifecycle and domain changes need the Manage tenant lifecycle permission.',
    );
  });
});

describe('Skeleton + EmptyState (handoff §3.6)', () => {
  it('renders static blocks with a status for assistive tech', () => {
    const { container } = render(
      <>
        <Skeleton width={48} height={30} radius={6} />
        <SkeletonPanel />
      </>,
    );
    expect(container.querySelectorAll('.pw-skeleton')).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('renders the empty state title, line and action', () => {
    render(<EmptyState title="No tenants waiting" body="Every provisioned tenant's owner has signed in." action={<span>act</span>} />);
    expect(screen.getByText('No tenants waiting')).toBeInTheDocument();
    expect(screen.getByText("Every provisioned tenant's owner has signed in.")).toBeInTheDocument();
    expect(screen.getByText('act')).toBeInTheDocument();
  });
});

describe('Stepper (handoff §6.2)', () => {
  it('marks done, current and to-do steps', () => {
    render(<Stepper steps={['Organization & owner', 'Capabilities', 'Review']} current={2} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('✓Organization & owner (completed)');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveTextContent('3Review');
    expect(items[2]).not.toHaveAttribute('aria-current');
  });
});

describe('DiffView (handoff §9)', () => {
  it('prefixes changed rows with a sign and hidden text', () => {
    render(
      <DiffView
        rows={[
          { key: 'a', kind: 'same', text: 'k8s', sub: 'Abbreviation' },
          { key: 'b', kind: 'added', text: 'kube', sub: 'Common name' },
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveAttribute('data-kind', 'same');
    expect(rows[1]).toHaveTextContent('+Added: kubeCommon name');
  });
});
