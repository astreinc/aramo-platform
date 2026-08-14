import { Link } from 'react-router-dom';

// T9-B2 — the Reporting area index (/reports). The single "Reports" rail entry
// now lands here (§13: evolve the Reports IA without a second ambiguous
// top-level rail entry); this page links to each dedicated report page. Each
// report remains its own route/component — this is a thin index, not a
// dashboard.
export function ReportingLanding(): JSX.Element {
  return (
    <section aria-labelledby="reports-heading">
      <h1 id="reports-heading">Reports</h1>
      <p>Operational reporting.</p>
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
      </ul>
    </section>
  );
}
