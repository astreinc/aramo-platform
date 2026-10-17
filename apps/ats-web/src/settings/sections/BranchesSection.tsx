import { Link } from 'react-router-dom';

import { Card } from '../../ui';
import { SettingCardHead, SettingHint, SettingsSection } from '../components';

// Settings Rebuild Directive 1 + 4 — Teams & organisation.
//
// D-ORG-3: Branches (sites) are ORGANIZATION structure and moved to Organization
// Administration (/org/sites on the App Home) — linked from here, never
// duplicated. Teams (recruiting pods) + the reporting hierarchy are ATS-owned
// and stay LIVE here (the full surfaces render at /admin/teams and /admin/org
// inside this same shell).

export function BranchesSection() {
  return (
    <SettingsSection
      title="Teams & organisation"
      description="Recruiting teams and the reporting hierarchy — live. Sites (branches) are organization structure, managed in Organization administration."
    >
      {/* D-ORG-3 — Sites moved to Organization Administration (/org/sites). */}
      <Card flush>
        <SettingCardHead title="Sites & branches" sub="Your organization's locations are shared by every Aramo product." />
        <div className="rc-card--pad">
          <p className="set-muted">
            Sites are managed in Organization administration on the App Home.
          </p>
          <div className="rc-formfoot">
            <a href="/org/sites" className="rc-link-action" data-testid="branches-sites-link">
              Manage sites
            </a>
          </div>
        </div>
      </Card>

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
