import { Link } from 'react-router-dom';

import { Card } from '../../ui';
import { SettingCardHead, SettingHint, SettingsSection } from '../components';
import { SitesPanel } from '../sites/SitesPanel';

// Settings Rebuild Directive 1 + 4 — Branches & teams.
//
// Branches (sites) are now LIVE (Directive 4 — full CRUD + hierarchy over the
// Site model, replacing the D1 honest seam). Teams + org are LIVE entry points
// (the built modules re-homed here; the full surfaces render at /admin/teams
// and /admin/org inside this same shell).

export function BranchesSection() {
  return (
    <SettingsSection
      title="Branches & teams"
      description="Aramo is multi-tenant with multi-branch capability. Branches (sites), teams, and the reporting hierarchy are all live."
    >
      {/* LIVE — Branches (sites) CRUD + hierarchy (Directive 4) */}
      <SitesPanel />

      {/* LIVE — Teams */}
      <Card flush>
        <SettingCardHead title="Teams" sub="Group users into pods, manage members, and assign client companies." />
        <div className="rc-card--pad">
          <p className="set-muted">
            Pods sit inside the tenant — the unit a lead recruiter assigns within.
          </p>
          <div className="rc-formfoot">
            <Link to="/admin/teams" className="rc-link-action" data-testid="branches-teams-link">
              Manage teams
            </Link>
          </div>
        </div>
      </Card>

      {/* LIVE — Organisation */}
      <Card flush>
        <SettingCardHead title="Organisation" sub="Manage the reporting hierarchy (who reports to whom) across the tenant." />
        <div className="rc-card--pad">
          <p className="set-muted">
            The management hierarchy drives record-level visibility across the ATS.
          </p>
          <div className="rc-formfoot">
            <Link to="/admin/org" className="rc-link-action" data-testid="branches-org-link">
              Manage organisation
            </Link>
          </div>
        </div>
      </Card>

      <SettingHint>
        Scoping flows tenant → branch → team. Branch sits between the tenant and its teams; teams are
        the pod a lead recruiter works within.
      </SettingHint>
    </SettingsSection>
  );
}
