import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RolePicker } from './RolePicker';
import { ROLE_FIXTURE } from './roles.fixture';

describe('RolePicker — the shared multi-select', () => {
  it('renders all 13 catalog roles', () => {
    const { container } = render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        financialsToggle={{ state: 'unknown' }}
      />,
    );
    // Use the data-role-key attribute for unambiguous lookup — role
    // labels overlap (Recruiter / Lead Recruiter / Recruiting Manager).
    for (const entry of ROLE_FIXTURE) {
      expect(
        container.querySelector(`[data-role-key="${entry.key}"]`),
      ).not.toBeNull();
    }
  });

  it('reflects the selectedKeys set as checked checkboxes', () => {
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set(['recruiter', 'finance'])}
        onToggle={() => undefined}
        financialsToggle={{ state: 'unknown' }}
      />,
    );
    const recruiter = screen.getByLabelText(/^Recruiter/) as HTMLInputElement;
    const finance = screen.getByLabelText(/^Finance/) as HTMLInputElement;
    const sourcer = screen.getByLabelText(/^Sourcer/) as HTMLInputElement;
    expect(recruiter.checked).toBe(true);
    expect(finance.checked).toBe(true);
    expect(sourcer.checked).toBe(false);
  });

  it('invokes onToggle(key, nextChecked) when a row is clicked', () => {
    const onToggle = vi.fn();
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={onToggle}
        financialsToggle={{ state: 'unknown' }}
      />,
    );
    fireEvent.click(screen.getByLabelText(/^Recruiter/));
    expect(onToggle).toHaveBeenCalledWith('recruiter', true);
  });

  it('S4 — proactively disables auditor_with_financials when toggle is known-off', () => {
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        financialsToggle={{ state: 'known', enabled: false }}
      />,
    );
    const checkbox = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    // The helper message points the admin at Settings.
    expect(
      screen.getByText(/Enable "Financial-auditor grant" in Settings/i),
    ).toBeInTheDocument();
  });

  it('S4 — leaves auditor_with_financials ENABLED when toggle is known-on', () => {
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        financialsToggle={{ state: 'known', enabled: true }}
      />,
    );
    const checkbox = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('S4 — falls through (option stays enabled) when toggle is unknown (403 probe)', () => {
    // Ruling 4: a pure user-manage admin without tenant:admin:settings
    // gets `unknown` from the courtesy probe; the BE rejection is the
    // floor. The picker MUST NOT block the option in this case.
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        financialsToggle={{ state: 'unknown' }}
      />,
    );
    const checkbox = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('disables every option when the global disabled prop is true', () => {
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        disabled
        financialsToggle={{ state: 'known', enabled: true }}
      />,
    );
    const recruiter = screen.getByLabelText(/^Recruiter/) as HTMLInputElement;
    expect(recruiter.disabled).toBe(true);
  });

  it('candidate IS in the picker (ruling 5 — mirrors the catalog)', () => {
    render(
      <RolePicker
        roles={ROLE_FIXTURE}
        selectedKeys={new Set()}
        onToggle={() => undefined}
        financialsToggle={{ state: 'unknown' }}
      />,
    );
    expect(screen.getByLabelText(/^Candidate/)).toBeInTheDocument();
  });
});
