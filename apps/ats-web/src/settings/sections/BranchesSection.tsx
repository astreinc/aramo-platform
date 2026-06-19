import { Link } from 'react-router-dom';

import { IconBranch } from '../../ui/icons';
import { Card } from '../../ui';
import {
  SettingCardHead,
  SettingHint,
  SettingsSeam,
  SettingsSection,
} from '../components';

// Settings Rebuild Directive 1 — Branches & teams.
//
// Teams + org are LIVE (the built modules re-homed here as entry points; the
// full surfaces render at /admin/teams and /admin/org inside this same shell).
// Sites/branches CRUD has only a `Site` model with no endpoints yet — an HONEST
// SEAM (built in PR 4), so the multi-branch model is visible from day one
// without a control that persists nothing.

export function BranchesSection() {
  return (
    <SettingsSection
      title="Branches & teams"
      description="Aramo is multi-tenant with multi-branch capability. Teams and the reporting hierarchy are live today; branch (site) management is on the roadmap."
    >
      {/* SEAM — Sites/branches CRUD (Site model exists, no endpoints) */}
      <SettingsSeam
        icon={<IconBranch />}
        title="Branches (sites)"
        vision={[
          'Create and manage branch sites — headquarters, regional offices, distributed pods.',
          'Scope users, ownership and localization to a branch.',
          'Per-branch reporting rollup.',
        ]}
      >
        Branch (site) management has a data model but no CRUD surface yet. Until it ships, this is a
        roadmap surface — teams below already provide the working sub-tenant grouping.
      </SettingsSeam>

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
