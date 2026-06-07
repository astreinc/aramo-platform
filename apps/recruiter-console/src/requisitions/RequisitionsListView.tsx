import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  Switch,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { listRequisitions } from './requisitions-api';
import { listErrorMessage } from './error-messages';
import { isClosedStatus, type RequisitionView } from './types';

// Q2 ruling — the LIST is the "my open reqs" entry; active-filtered
// by default with a "Show closed" toggle.
// Visibility (D4b) is BE-applied — the recruiter sees own-assigned;
// invisible→404 on detail; the LIST already only contains visible reqs.

interface RequisitionsListViewProps {
  // R4 test seam — pass a fixed session so the "+ New" gate is
  // exercisable in tests without mounting the real session hook.
  readonly sessionOverride?: Session;
}

export function RequisitionsListView({ sessionOverride }: RequisitionsListViewProps = {}) {
  const [items, setItems] = useState<readonly RequisitionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  // Defensive: in tests the session fetch may return a non-Session
  // shape (a global fetch mock for the LIST endpoint can leak into the
  // session probe). Guard so an unparseable session can't crash render.
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'requisition:create');

  useEffect(() => {
    let cancelled = false;
    listRequisitions()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(listErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => (showClosed ? items : items.filter((r) => !isClosedStatus(r.status))),
    [items, showClosed],
  );

  return (
    <section>
      <PageHeader
        title="My open requisitions"
        description="Requisitions assigned to you or visible through your client work."
      />
      <div className="reqs-list__toolbar">
        <label className="reqs-list__toggle">
          <Switch checked={showClosed} onCheckedChange={setShowClosed} />
          <span>Show closed</span>
        </label>
        {canCreate ? (
          <Link to="/requisitions/new" className="reqs-list__new-link">
            + New requisition
          </Link>
        ) : null}
      </div>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {loading ? (
        <p>Loading requisitions…</p>
      ) : filtered.length === 0 ? (
        <p>
          {showClosed
            ? 'No requisitions visible to you yet.'
            : 'No open requisitions. Toggle "Show closed" to see closed work.'}
        </p>
      ) : (
        <ul className="reqs-list">
          {filtered.map((req) => (
            <li key={req.id}>
              <Link to={`/requisitions/${req.id}`} className="reqs-list__link">
                <Card>
                  <div className="reqs-list__row">
                    <div>
                      <p className="reqs-list__title">{req.title}</p>
                      <p className="reqs-list__meta">
                        Status: <strong>{req.status}</strong> · Openings:{' '}
                        <strong>
                          {req.openings_available}/{req.openings}
                        </strong>
                      </p>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
