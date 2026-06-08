import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  InlineAlert,
  PageHeader,
  Table,
  hasScope,
  useSession,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import { listTalent } from './talent-api';
import { listErrorMessage } from './error-messages';
import type { TalentRecordView } from './types';

// R2 — the Talent LIST. POOL-OPEN framing (ruling 1): the BE returns
// the tenant + site talent pool with NO assignment filter; a recruiter
// sees the SHARED pool, not a personal list. The header / empty-state
// copy reflects that honestly.
//
// Large-table treatment (ruling 5): the BE caps at 50 default; when the
// list hits the cap the view surfaces an honest truncation disclosure.
// Cursor pagination is a backend-first carry.
//
// R3 — the primary-name cell renders a <Link> to /talent/:id. Ruling 5:
// row-nav is a column-content change (not a Table rowHref prop) so the
// frozen foundation Table stays untouched. Explicit focusable affordance.

// Mirrors the BE default cap (libs/talent-record/src/lib/talent-record
// .repository.ts list()). When the list length equals the cap, we
// disclose the truncation honestly; the actual upper bound may be
// greater (BE max=200) but the LIST defaults to 50.
const DEFAULT_LIST_CAP = 50;

function fullName(t: TalentRecordView): string {
  const first = t.first_name.trim();
  const last = t.last_name.trim();
  if (first === '' && last === '') return '—';
  return `${first} ${last}`.trim();
}

function firstNonNullPhone(t: TalentRecordView): string {
  return t.phone_cell ?? t.phone_home ?? t.phone_work ?? '—';
}

function display(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function truncate(value: string | null, max: number): string {
  if (value === null || value === '') return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const columns: ReadonlyArray<TableColumn<TalentRecordView>> = [
  {
    key: 'name',
    header: 'Name',
    render: (t) => <Link to={`/talent/${t.id}`}>{fullName(t)}</Link>,
  },
  {
    key: 'email',
    header: 'Email',
    render: (t) => display(t.email1),
  },
  {
    key: 'phone',
    header: 'Phone',
    render: (t) => firstNonNullPhone(t),
  },
  {
    key: 'current_employer',
    header: 'Current employer',
    render: (t) => display(t.current_employer),
  },
  {
    key: 'key_skills',
    header: 'Key skills',
    render: (t) => (
      <span title={t.key_skills ?? undefined}>{truncate(t.key_skills, 60)}</span>
    ),
  },
  {
    key: 'is_hot',
    header: 'Hot',
    width: '80px',
    render: (t) => (t.is_hot ? 'Yes' : ''),
  },
  {
    key: 'can_relocate',
    header: 'Relocate',
    width: '100px',
    render: (t) => (t.can_relocate ? 'Yes' : ''),
  },
];

interface TalentListViewProps {
  // R5 test seam — pass a fixed session so the "+ New" gate is
  // exercisable in tests without mounting the real session hook.
  readonly sessionOverride?: Session;
}

export function TalentListView({ sessionOverride }: TalentListViewProps = {}) {
  const [items, setItems] = useState<readonly TalentRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  // Defensive (R4 LIST precedent): in tests the session fetch may
  // return a non-Session shape; guard so a malformed session can't
  // crash render.
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'talent:create');

  useEffect(() => {
    let cancelled = false;
    listTalent()
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

  const truncated = items.length >= DEFAULT_LIST_CAP;

  return (
    <section>
      <PageHeader
        title="Talent"
        description="Tenant talent pool — visible to all recruiters in your site."
      />
      {canCreate ? (
        <p className="talent-list__toolbar">
          <Link to="/talent/new" className="talent-list__new-link">
            + New talent
          </Link>
        </p>
      ) : null}
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {loading ? (
        <p>Loading talent…</p>
      ) : (
        <>
          {truncated ? (
            <p role="status" data-testid="talent-cap-banner">
              Showing first {DEFAULT_LIST_CAP} talent records. More may exist
              beyond this page; cursor pagination is on the roadmap.
            </p>
          ) : null}
          <Table<TalentRecordView>
            columns={columns}
            rows={items}
            rowKey={(t) => t.id}
            emptyMessage="No talent yet in this tenant pool."
          />
        </>
      )}
    </section>
  );
}
