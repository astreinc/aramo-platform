import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RolesMatrixView } from './RolesMatrixView';
import type { RoleCatalogView } from './roles-catalog-api';

// Settings Rebuild Directive 5 — the Roles & permissions matrix (READ-ONLY).

const CATALOG: readonly RoleCatalogView[] = [
  {
    key: 'tenant_admin',
    display: 'Tenant Admin',
    description: 'Administrative operator of the tenant.',
    tier: 'Administration',
    scopes: ['talent:read', 'tenant:admin:user-manage', 'company:read'],
  },
  {
    key: 'recruiter',
    display: 'Recruiter',
    description: 'Core operator.',
    tier: 'Operations',
    scopes: ['talent:read', 'talent:create'],
  },
  {
    key: 'auditor_with_financials',
    display: 'Auditor with Financials',
    description: 'Compliance reads + see-all compensation.',
    tier: 'Finance & compliance',
    scopes: ['audit:read'],
    requires_setting: {
      setting_key: 'audit.financials_enabled',
      disabled_message: 'Enable the grant first.',
    },
  },
];

function renderMatrix() {
  return render(<RolesMatrixView fetchFn={() => Promise.resolve(CATALOG)} />);
}

describe('RolesMatrixView', () => {
  it('lists the roles grouped by tier and selects the first by default', async () => {
    renderMatrix();
    expect(await screen.findByTestId('role-item-tenant_admin')).toBeInTheDocument();
    expect(screen.getByTestId('role-item-recruiter')).toBeInTheDocument();
    // Tier labels (the 'Administration' string also appears as a scope category,
    // so assert presence, not uniqueness).
    expect(screen.getAllByText('Administration').length).toBeGreaterThan(0);
    expect(screen.getByText('Finance & compliance')).toBeInTheDocument();
    // Default selection = first role; its scopes are shown.
    expect(screen.getByTestId('role-scopes-tenant_admin')).toBeInTheDocument();
  });

  it('shows the selected role scopes grouped by category', async () => {
    renderMatrix();
    fireEvent.click(await screen.findByTestId('role-item-recruiter'));
    await waitFor(() =>
      expect(screen.getByTestId('role-scopes-recruiter')).toBeInTheDocument(),
    );
    expect(screen.getByText('Talent')).toBeInTheDocument();
    expect(screen.getByText('talent:create')).toBeInTheDocument();
  });

  it('is READ-ONLY — no edit / assign / revoke affordance anywhere', async () => {
    renderMatrix();
    await screen.findByTestId('role-item-tenant_admin');
    // The only buttons are the role-selector list items; none mutate.
    const buttons = screen.getAllByRole('button');
    for (const b of buttons) {
      expect(b.getAttribute('data-testid') ?? '').toMatch(/^role-item-/);
      expect(b.textContent ?? '').not.toMatch(/edit|assign|revoke|save|remove|add/i);
    }
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('surfaces the read-only safety rationale', async () => {
    renderMatrix();
    await screen.findByTestId('role-item-tenant_admin');
    expect(screen.getByText(/read-only view of the permission model/i)).toBeInTheDocument();
  });

  it('surfaces a load error honestly', async () => {
    render(<RolesMatrixView fetchFn={() => Promise.reject(new Error('boom'))} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
