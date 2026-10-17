import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AdminGate } from '../admin/AdminGate';

import { SettingsShell, SETTINGS_NAV } from './SettingsShell';
import { SettingsView } from './SettingsView';
import { BranchesSection } from './sections/BranchesSection';
import {
  ApplySection,
  EmailSection,
  FieldsSection,
  IntegrationsSection,
  PortalSection,
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
                      element={<Navigate to="/admin/settings/recruiting" replace />}
                    />
                    <Route
                      path="settings/recruiting"
                      element={
                        <SettingsView
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
                    <Route path="settings/portal" element={<PortalSection />} />
                    <Route path="settings/apply" element={<ApplySection />} />
                    <Route path="settings/email" element={<EmailSection />} />
                    <Route path="settings/fields" element={<FieldsSection />} />
                    <Route
                      path="settings/integrations"
                      element={<IntegrationsSection />}
                    />
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
  it('renders every grouped ATS-owned section in the rail + the Organization link (D-ORG-3)', () => {
    renderAt('/admin/settings/recruiting', makeSession(['tenant:admin:settings']));
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    // The ATS-owned group headings (People & access / Account moved to /org/*).
    for (const heading of [
      'Organization',
      'Workspace',
      'Talent experience',
      'Communication',
      'Recruiting',
      'Documents',
      'Data',
      'Connect',
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
    // D-ORG-3 — the organization-owned sections are NOT in this rail; the rail
    // links OUT to Organization administration with a host-level anchor (the
    // ATS basename must not be applied — it is a different SPA on this host).
    for (const gone of ['profile', 'users', 'roles', 'security', 'domain', 'localization', 'billing', 'audit']) {
      expect(screen.queryByTestId(`settings-nav-${gone}`)).toBeNull();
    }
    expect(within(nav).queryByText('People & access')).toBeNull();
    expect(within(nav).queryByText('Account')).toBeNull();
    const org = screen.getByTestId('settings-nav-organization');
    expect(org.tagName).toBe('A');
    expect(org).toHaveAttribute('href', '/org/');
  });

  it('marks the active section with aria-current', () => {
    renderAt('/admin/settings/recruiting', makeSession(['tenant:admin:settings']));
    expect(screen.getByTestId('settings-nav-recruiting-settings')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('settings-nav-import')).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('blocks a non-admin from the whole settings subtree (ForbiddenState)', () => {
    renderAt('/admin/settings/recruiting', makeSession(['talent:read']));
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /settings sections/i })).toBeNull();
  });

  it('the index redirects into the settings rail (Recruiting settings — D-ORG-3)', async () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    expect(
      await screen.findByRole('heading', { name: /recruiting settings/i }),
    ).toBeInTheDocument();
  });
});

describe('Honest seams — no dead knobs', () => {
  it('every seam section is clearly marked coming-soon / on the roadmap', () => {
    const cases: [string, () => void][] = [
      // 'settings/localization', 'settings/security', 'settings/billing' moved to
      // Organization administration (D-ORG-3) — covered by libs/org-admin-web.
      // 'settings/email' is now LIVE (D-EMAIL-TPL-1 ET-6) — covered by EmailTemplatesPanel.spec.
      ['settings/fields', () => undefined],
      ['settings/integrations', () => undefined],
      // 'settings/audit' is now LIVE (Directive 2) — moved to /org/audit (D-ORG-3).
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
    renderAt('/admin/settings/recruiting', makeSession(['tenant:admin:settings']));
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
