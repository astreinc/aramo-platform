import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { Tabs, type TabItem } from '../components/Tabs';
import { TasksPanel } from '../task/TasksPanel';
import { listActivities } from '../activity/activity-api';
import { timelineErrorMessage } from '../activity/error-messages';
import type { ActivityView } from '../activity/types';
import { listRequisitions } from '../requisitions/requisitions-api';
import {
  isClosedStatus,
  type RequisitionView,
} from '../requisitions/types';

import {
  getCompany,
  listContactsForCompany,
} from './companies-api';
import {
  contactsErrorMessage,
  detailErrorMessage,
  reqsErrorMessage,
} from './error-messages';
import type { CompanyView, ContactView } from './types';

// R3 — the recruiter-tier company DETAIL composite. Tabs: Profile /
// Contacts / Assigned-reqs / Activity. CLOSES the S5c-3 #1 discovery
// gap at the RECRUITER tier (NOT cross-app to the admin assignments
// editor — different app / scope / intent).
//
// Per-tab scope-gating: Profile uses the base scope (company:read) and
// is always present when the route renders; Contacts / Assigned-reqs /
// Activity are added only when their per-feature scope is granted. A
// tab the actor can't read is HIDDEN.
//
// Assigned-reqs: /v1/requisitions?company_id=<id> (server ANDs
// company_id with the A3/D4b visibility predicate; the FE just passes
// company_id and renders). The R3 client-side filter + capped-50
// banner were retired when ?company_id shipped — the company-scoped
// list is now complete within the actor's visibility.
//
// Ruling 3 (Activity CONFIRMED-BUT-EMPTY): subject_type='company' is
// accepted by the read endpoint, but no write path produces such rows
// today. We wire the read forward-compatibly (it lights up if company
// activities are ever written) + an end-user-honest empty-state. The
// copy stays user-facing, NOT architectural — recruiters do not need
// to read internal substrate detail.

interface CompanyDetailViewProps {
  // Test seam — mirrors fe-foundation's RouteGuard.sessionStateOverride.
  readonly sessionOverride?: Session;
}

function location(c: CompanyView): string {
  const parts: string[] = [];
  if (c.city !== null && c.city !== '') parts.push(c.city);
  if (c.state !== null && c.state !== '') parts.push(c.state);
  return parts.length === 0 ? '—' : parts.join(', ');
}

function display(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function fullContactName(c: ContactView): string {
  const first = c.first_name.trim();
  const last = c.last_name.trim();
  if (first === '' && last === '') return '—';
  return `${first} ${last}`.trim();
}

export function CompanyDetailView({ sessionOverride }: CompanyDetailViewProps) {
  const { companyId } = useParams<{ companyId: string }>();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [company, setCompany] = useState<CompanyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (companyId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCompany(companyId)
      .then((res) => {
        if (cancelled) return;
        setCompany(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (companyId === undefined) {
    return <InlineAlert variant="error">Missing company id in URL.</InlineAlert>;
  }
  if (loading) return <p>Loading company…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Company" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/companies">← Back to companies</Link>
        </p>
      </section>
    );
  }
  if (company === null || session === null) return null;

  const scopes = session.scopes;
  const canEditCompany = hasScope(session, 'company:edit');
  const canCreateContact = hasScope(session, 'contact:create');
  const canEditContact = hasScope(session, 'contact:edit');
  const tabs: TabItem[] = [
    {
      id: 'profile',
      label: 'Profile',
      content: (
        <ProfilePanel company={company} canEdit={canEditCompany} />
      ),
    },
  ];
  if (scopes.includes('contact:read')) {
    tabs.push({
      id: 'contacts',
      label: 'Contacts',
      content: (
        <ContactsPanel
          companyId={company.id}
          canCreate={canCreateContact}
          canEdit={canEditContact}
        />
      ),
    });
  }
  if (scopes.includes('requisition:read')) {
    tabs.push({
      id: 'assigned-reqs',
      label: 'Assigned reqs',
      content: <AssignedReqsPanel companyId={company.id} />,
    });
  }
  if (scopes.includes('activity:read')) {
    tabs.push({
      id: 'activity',
      label: 'Activity',
      content: <ActivityPanel companyId={company.id} />,
    });
  }
  if (scopes.includes('task:read')) {
    tabs.push({
      id: 'tasks',
      label: 'Tasks',
      content: (
        <TasksPanel
          ownerType="company"
          ownerId={company.id}
          canWrite={scopes.includes('task:write')}
        />
      ),
    });
  }

  return (
    <section>
      <PageHeader
        title={company.name}
        description="A client visible to you."
      />
      <p>
        <Link to="/companies">← Back to companies</Link>
      </p>
      <Tabs items={tabs} ariaLabel="Company details" />
    </section>
  );
}

function ProfilePanel({
  company,
  canEdit,
}: {
  company: CompanyView;
  canEdit: boolean;
}) {
  return (
    <Card>
      {canEdit ? (
        <div className="detail__actions">
          <Link
            to={`/companies/${company.id}/edit`}
            className="detail__edit-link"
          >
            Edit
          </Link>
        </div>
      ) : null}
      <dl className="detail__meta">
        <div>
          <dt>Location</dt>
          <dd>{location(company)}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{display(company.phone1)}</dd>
        </div>
        <div>
          <dt>Website</dt>
          <dd>{display(company.url)}</dd>
        </div>
        <div>
          <dt>Key technologies</dt>
          <dd>{display(company.key_technologies)}</dd>
        </div>
        <div>
          <dt>Hot</dt>
          <dd>{company.is_hot ? 'Yes' : 'No'}</dd>
        </div>
        {company.notes !== null && company.notes !== '' ? (
          <div>
            <dt>Notes</dt>
            <dd>{company.notes}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function ContactsPanel({
  companyId,
  canCreate,
  canEdit,
}: {
  companyId: string;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<readonly ContactView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listContactsForCompany(companyId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(contactsErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (loading) return <p>Loading contacts…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;

  return (
    <div>
      {canCreate ? (
        <div className="detail__actions">
          <Link
            to={`/companies/${companyId}/contacts/new`}
            className="detail__new-link"
          >
            + New contact
          </Link>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p>No contacts for this company yet.</p>
      ) : (
        <ul className="detail__list">
          {items.map((c) => (
            <li key={c.id}>
              <strong>{fullContactName(c)}</strong>
              {c.title !== null && c.title !== '' ? ` · ${c.title}` : ''}
              {c.email1 !== null && c.email1 !== '' ? ` · ${c.email1}` : ''}
              {c.left_company ? ' · (left company)' : ''}
              {canEdit ? (
                <>
                  {' · '}
                  <Link to={`/contacts/${c.id}/edit`}>Edit</Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignedReqsPanel({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<readonly RequisitionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRequisitions({ company_id: companyId })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items.filter((r) => !isClosedStatus(r.status)));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(reqsErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (loading) return <p>Loading requisitions…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;

  return (
    <div>
      {items.length === 0 ? (
        <p>No active requisitions for this company yet.</p>
      ) : (
        <ul className="detail__list">
          {items.map((r) => (
            <li key={r.id}>
              <Link to={`/requisitions/${r.id}`}>{r.title}</Link> — {r.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityPanel({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listActivities('company', companyId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(timelineErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (loading) return <p>Loading activity…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (items.length === 0) {
    // Ruling 3: end-user-honest copy. The Gate-5 finding (no write path
    // produces company-subject rows today) is a project truth, NOT the
    // recruiter's concern.
    return <p>No activity recorded for this company yet.</p>;
  }
  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id} className="timeline__item">
          <Card>
            <p>{a.notes ?? a.type}</p>
            <time dateTime={a.created_at}>{a.created_at}</time>
          </Card>
        </li>
      ))}
    </ul>
  );
}
