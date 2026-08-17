import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AdminGate } from '../admin/AdminGate';

import { SettingsShell, SETTINGS_NAV } from './SettingsShell';
import { TenantProfileSection } from './sections/TenantProfileSection';
import { BranchesSection } from './sections/BranchesSection';
import {
  ApplySection,
  BillingSection,
  EmailSection,
  FieldsSection,
  IntegrationsSection,
  LocalizationSection,
  PortalSection,
  SecuritySection,
} from './sections/SeamSections';

// Settings Rebuild Directive 1 — the shell + rail + seam honesty.
//
// Mirrors App.tsx's admin subtree (AdminGate → SettingsShell layout → section
// routes) so the rail, the active state, the admin gate, and the no-dead-knobs
// seam discipline are all exercised together.

function makeSession(scopes: readonly string[]): Session {
  return {
    sub: 'user-1',
    consumer_type: 'recruiter',
    tenant_id: 'tenant-abc',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  };
}

function renderAt(path: string, session: Session) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="admin/*"
            element={
              <AdminGate session={session}>
                <Routes>
                  <Route element={<SettingsShell />}>
                    <Route
                      index
                      element={<Navigate to="/admin/settings/profile" replace />}
                    />
                    <Route
                      path="settings/profile"
                      element={
                        <TenantProfileSection
                          fetchFn={() =>
                            Promise.resolve({
                              'compensation.display_default': 'both',
                              'audit.financials_enabled': false,
                            })
                          }
                        />
                      }
                    />
                    <Route path="settings/branches" element={<BranchesSection />} />
                    <Route path="settings/localization" element={<LocalizationSection />} />
                    <Route path="settings/security" element={<SecuritySection />} />
                    <Route path="settings/portal" element={<PortalSection />} />
                    <Route path="settings/apply" element={<ApplySection />} />
                    <Route path="settings/email" element={<EmailSection />} />
                    <Route path="settings/fields" element={<FieldsSection />} />
                    <Route
                      path="settings/integrations"
                      element={<IntegrationsSection />}
                    />
                    <Route path="settings/billing" element={<BillingSection />} />
                  </Route>
                </Routes>
              </AdminGate>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Settings shell + rail', () => {
  it('renders every grouped section in the rail (16 capabilities present)', () => {
    renderAt('/admin/settings/profile', makeSession(['tenant:admin:settings']));
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    // All six group headings.
    for (const heading of [
      'Workspace',
      'People & access',
      'Talent experience',
      'Communication',
      'Data',
      'Connect',
      'Account',
    ]) {
      expect(within(nav).getByText(heading)).toBeInTheDocument();
    }
    // Every section key has a rail link.
    const keys = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.key));
    for (const key of keys) {
      expect(screen.getByTestId(`settings-nav-${key}`)).toBeInTheDocument();
    }
    // The residual admin-tools affordance (ruling C).
    expect(screen.getByTestId('settings-nav-tools')).toBeInTheDocument();
  });

  it('marks the active section with aria-current', () => {
    renderAt('/admin/settings/profile', makeSession(['tenant:admin:settings']));
    expect(screen.getByTestId('settings-nav-profile')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('settings-nav-import')).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('blocks a non-admin from the whole settings subtree (ForbiddenState)', () => {
    renderAt('/admin/settings/profile', makeSession(['talent:read']));
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /settings sections/i })).toBeNull();
  });

  it('the index redirects into the settings rail (Tenant profile)', async () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    expect(
      await screen.findByRole('heading', { name: 'Tenant profile' }),
    ).toBeInTheDocument();
  });
});

describe('Honest seams — no dead knobs', () => {
  it('every seam section is clearly marked coming-soon / on the roadmap', () => {
    const cases: [string, () => void][] = [
      ['settings/localization', () => undefined],
      ['settings/security', () => undefined],
      ['settings/email', () => undefined],
      ['settings/fields', () => undefined],
      ['settings/integrations', () => undefined],
      ['settings/billing', () => undefined],
      // 'settings/audit' is now LIVE (Directive 2) — covered by AuditLogView.spec.
    ];
    for (const [path] of cases) {
      const { unmount } = renderAt(
        `/admin/${path}`,
        makeSession(['tenant:admin:settings']),
      );
      // A seam tag is present and there is no functional form control.
      const tags = screen.getAllByText(/coming soon|next release|delivered by §5/i);
      expect(tags.length).toBeGreaterThan(0);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('Career portal + Apply flow are FORBIDDEN seams — roadmap-only, never wired', () => {
    for (const path of ['settings/portal', 'settings/apply']) {
      const { unmount } = renderAt(
        `/admin/${path}`,
        makeSession(['tenant:admin:settings']),
      );
      expect(screen.getAllByText(/on the roadmap/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/refusal layer forbids/i)).toBeInTheDocument();
      // Not wired: no inputs, switches or buttons that imply function.
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  // ── T10-B1/F-010 — Integrations is LIVE (T8-P3 monitoring + T8-CONNECTOR-A);
  //    the stale "Soon" badge is dropped and nothing implies Connector-B /
  //    provider selection / production onboarding. ──
  it('presents Integrations as a live section — no stale "Soon" badge', () => {
    renderAt('/admin/settings/profile', makeSession(['tenant:admin:settings']));
    const link = screen.getByTestId('settings-nav-integrations');
    expect(link).toHaveTextContent('Integrations');
    expect(link.textContent).not.toContain('Soon');
    expect(link.textContent).not.toMatch(/Connector-B|provider|onboarding/i);
  });

  it('marks the Integrations nav item status "live" with no badge in SETTINGS_NAV', () => {
    const integrations = SETTINGS_NAV.flatMap((g) => g.items).find(
      (i) => i.key === 'integrations',
    );
    expect(integrations).toBeDefined();
    expect(integrations?.status).toBe('live');
    expect(integrations?.badge).toBeUndefined();
  });
});
