import { Link } from 'react-router-dom';
import { IconBranch, IconBuilding, IconUsers, orgEntryHref } from '@aramo/fe-foundation';

import { Card } from '../../ui';
import { SettingCardHead, SettingHint, SettingsSection } from '../components';

// Teams & reporting hierarchy (accepted Settings & navigation change log A3;
// frozen Settings prototype 2026-10-18). Teams (recruiting pods) and the
// reporting hierarchy are ATS-owned and live here; Sites are organization
// structure, managed in Organization administration (App Home /org/sites) —
// linked with this page as the return context, never duplicated.
function hereForReturn(): string {
  return typeof window === 'undefined' ? '/ats/admin/settings/branches' : `${window.location.pathname}${window.location.search}`;
}

export function BranchesSection() {
  return (
    <SettingsSection
      title="Teams & reporting hierarchy"
      description="How recruiting work is grouped and who reports to whom inside Aramo ATS."
    >
      <Card flush>
        <div className="set-org-row">
          <span className="set-org-row__icon" aria-hidden="true">
            <IconBuilding />
          </span>
          <span className="set-org-row__text">
            <span className="set-org-row__t">Sites are managed in Organization administration</span>
            <span className="set-org-row__s">
              Sites (sometimes called branches) are shared by every Aramo app. Opens Organization › Sites;
              &ldquo;Back to ATS Settings&rdquo; brings you here.
            </span>
          </span>
          <a
            className="set-org-row__btn"
            href={orgEntryHref('sites', { app: 'ats', path: hereForReturn() })}
            data-testid="branches-sites-link"
          >
            Open Sites <span className="set-navbtn__badge set-navbtn__badge--app">App Home</span>
          </a>
        </div>
      </Card>

      <Card flush>
        <SettingCardHead icon={<IconUsers />} title="Teams" sub="Group users into pods, manage members, and assign client companies." />
        <div className="rc-card--pad">
          <p className="set-muted">Pods sit inside the tenant — the unit a lead recruiter assigns within.</p>
          <div className="rc-formfoot">
            <Link to="/admin/teams" className="rc-link-action" data-testid="branches-teams-link">
              Manage teams
            </Link>
          </div>
        </div>
      </Card>

      <Card flush>
        <SettingCardHead icon={<IconBranch />} title="Reporting hierarchy" sub="Who reports to whom inside Aramo ATS." />
        <div className="rc-card--pad">
          <p className="set-muted">The management hierarchy drives record-level visibility across the ATS.</p>
          <div className="rc-formfoot">
            <Link to="/admin/org" className="rc-link-action" data-testid="branches-org-link">
              Manage hierarchy
            </Link>
          </div>
        </div>
      </Card>

      <SettingHint>
        Scoping flows organization → site → ATS team. Sites come from Organization administration; ATS teams
        are the pod a lead recruiter works within.
      </SettingHint>
    </SettingsSection>
  );
}
