import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { Link } from 'react-router-dom';

import { PageHeader } from '../ui';

// T9-B2 — the Reporting area index (/reports). The single "Reports" rail entry
// now lands here (§13: evolve the Reports IA without a second ambiguous
// top-level rail entry); this page links to each dedicated report page. Each
// report remains its own route/component — this is a thin index, not a
// dashboard.
//
// T9-B4 — the Margin link is the fourth entry, shown ONLY when the actor holds
// assignment:commercials:read (§14): the reporting surface stays report:read, but
// the commercial disclosure gate hides the margin entry from actors without it.
// The backend independently 403s on direct navigation.
export function ReportingLanding({
  sessionOverride,
}: {
  readonly sessionOverride?: Session;
} = {}): JSX.Element {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canReadMargin =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'assignment:commercials:read');

  return (
    <section>
      <PageHeader title="Reports" description="Operational reporting." />
      <ul data-testid="reports-index">
        <li>
          <Link to="/reports/fill-performance" data-testid="reports-link-fill-performance">
            Fill Performance
          </Link>
        </li>
        <li>
          <Link to="/reports/fallthrough" data-testid="reports-link-fallthrough">
            Fallthrough
          </Link>
        </li>
        <li>
          <Link
            to="/reports/assignment-pipeline"
            data-testid="reports-link-assignment-pipeline"
          >
            Assignment Pipeline
          </Link>
        </li>
        <li>
          <Link to="/reports/guarantee-exposure" data-testid="reports-link-guarantee-exposure">
            Guarantee Exposure
          </Link>
        </li>
        {canReadMargin ? (
          <li>
            <Link to="/reports/margin" data-testid="reports-link-margin">
              Margin
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
