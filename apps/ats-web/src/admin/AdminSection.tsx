import { PageHeader } from '@aramo/fe-foundation';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button, Card, CardHead } from '../ui';

// AdminSection — the admin-gated landing (FE Consolidation). Rendered only
// behind <AdminGate> (the `tenant:admin:*` family gate), so by the time this
// mounts the principal is admin-scoped.
//
// All six admin modules now surface here (FE Consolidation complete). Self-
// contained routes (users / settings / org / teams) are direct links; consent +
// the assignment editors are per-record routes reached by direct URL (no
// discovery/list surface yet) — so their affordance is an ID lookup.

// A per-record deep-link affordance: an ID input + button that navigates to the
// record's editor. Used wherever a ported admin surface has no discovery/list
// surface yet (consent, the three assignment editors).
function IdLookup({
  ariaLabel,
  placeholder,
  buttonLabel,
  inputTestId,
  buttonTestId,
  toPath,
}: {
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly inputTestId: string;
  readonly buttonTestId: string;
  readonly toPath: (encodedId: string) => string;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  return (
    <form
      className="rc-mt-8 rc-admin-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed !== '') navigate(toPath(encodeURIComponent(trimmed)));
      }}
    >
      <input
        className="rc-input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid={inputTestId}
      />
      <Button type="submit" disabled={trimmed === ''} data-testid={buttonTestId}>
        {buttonLabel}
      </Button>
    </form>
  );
}

export function AdminSection() {
  return (
    <section className="rc-stack">
      <PageHeader
        title="Administration"
        description="Tenant administration tools."
      />

      <Card>
        <CardHead title="Users" />
        <p className="rc-muted-line rc-mt-8">
          Invite users, edit their roles, and disable access across the tenant.
        </p>
        <div className="rc-formfoot">
          <Link
            to="/admin/users"
            className="rc-link-action"
            data-testid="admin-users-link"
          >
            Open users
          </Link>
        </div>
      </Card>

      <Card>
        <CardHead title="Tenant settings" />
        <p className="rc-muted-line rc-mt-8">
          Compensation display default and the financial-auditor grant toggle.
        </p>
        <div className="rc-formfoot">
          <Link
            to="/admin/settings"
            className="rc-link-action"
            data-testid="admin-settings-link"
          >
            Open settings
          </Link>
        </div>
      </Card>

      <Card>
        <CardHead title="Organisation" />
        <p className="rc-muted-line rc-mt-8">
          Manage the reporting hierarchy (who reports to whom) across the tenant.
        </p>
        <div className="rc-formfoot">
          <Link
            to="/admin/org"
            className="rc-link-action"
            data-testid="admin-org-link"
          >
            Open organisation
          </Link>
        </div>
      </Card>

      <Card>
        <CardHead title="Teams" />
        <p className="rc-muted-line rc-mt-8">
          Group users into pods (each with an owner), manage members, and assign
          a team's client companies.
        </p>
        <div className="rc-formfoot">
          <Link
            to="/admin/teams"
            className="rc-link-action"
            data-testid="admin-teams-link"
          >
            Open teams
          </Link>
        </div>
      </Card>

      <Card>
        <CardHead title="Consent visibility" />
        <p className="rc-muted-line rc-mt-8">
          View a talent's consent state, history, and decision log. Enter a
          talent identifier to open its consent record.
        </p>
        <IdLookup
          ariaLabel="Talent identifier"
          placeholder="Talent ID"
          buttonLabel="View consent"
          inputTestId="admin-consent-talent-id"
          buttonTestId="admin-consent-open"
          toPath={(id) => `/admin/consent/${id}`}
        />
      </Card>

      <Card>
        <CardHead title="Assignments" />
        <p className="rc-muted-line rc-mt-8">
          Manage who is assigned to a company or requisition, or a team's client
          companies. These editors open per record — enter an ID.
        </p>
        <IdLookup
          ariaLabel="Company ID"
          placeholder="Company ID"
          buttonLabel="Company assignments"
          inputTestId="admin-company-assign-id"
          buttonTestId="admin-company-assign-open"
          toPath={(id) => `/admin/companies/${id}/assignments`}
        />
        <IdLookup
          ariaLabel="Requisition ID"
          placeholder="Requisition ID"
          buttonLabel="Requisition assignments"
          inputTestId="admin-req-assign-id"
          buttonTestId="admin-req-assign-open"
          toPath={(id) => `/admin/requisitions/${id}/assignments`}
        />
        <IdLookup
          ariaLabel="Team ID"
          placeholder="Team ID"
          buttonLabel="Team clients"
          inputTestId="admin-team-clients-id"
          buttonTestId="admin-team-clients-open"
          toPath={(id) => `/admin/teams/${id}/clients`}
        />
      </Card>
    </section>
  );
}
