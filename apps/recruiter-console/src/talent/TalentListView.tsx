import {
  Button,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Card,
  DataTable,
  EntityCell,
  FilterChip,
  ScopedSearch,
  TagList,
  Toolbar,
  type TableColumn,
} from '../ui';

import { listTalent } from './talent-api';
import { listErrorMessage } from './error-messages';
import type { TalentRecordView } from './types';

// Talent LIST (2E) — re-skinned to the Confident Blue "Candidates" mockup,
// but HONEST to the substrate:
//   - POOL-OPEN (R2 ruling): the BE returns the tenant+site talent pool, NOT a
//     personal working set. The mockup copy "your working set" would be
//     dishonest → kept as "Tenant talent pool". (Deviation noted in the report.)
//   - Refusal layer (G3/R7): footer states consented-pool, NO open-web talent
//     search, NO bulk export — the directive's required affordance copy.
//
// Gap dispositions (DDR §11): the mockup's Stage / Owner / Last-activity columns
// need per-talent pipeline + roster + activity lookups NOT in the list response
// → omitted (CARRY). Title/role subtitle: no field → omitted (gap #2). Rate is
// the talent-STATED freetext (current_pay/desired_pay; gap #3). Skills are the
// key_skills freetext split on commas into chips (gap #9). No fabricated fields.

const DEFAULT_LIST_CAP = 50;

type FilterMode = 'all' | 'mine';

function fullName(t: TalentRecordView): string {
  const name = `${t.first_name} ${t.last_name}`.trim();
  return name === '' ? '—' : name;
}

function statedRate(t: TalentRecordView): string {
  return t.current_pay ?? t.desired_pay ?? '—';
}

function locationOf(t: TalentRecordView): string {
  const place = [t.city, t.state].filter(Boolean).join(', ');
  return place === '' ? '—' : place;
}

function skillsOf(t: TalentRecordView): readonly string[] {
  if (t.key_skills === null) return [];
  return t.key_skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface TalentListViewProps {
  readonly sessionOverride?: Session;
}

export function TalentListView({ sessionOverride }: TalentListViewProps = {}) {
  const [items, setItems] = useState<readonly TalentRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'talent:create');
  const myId = session?.sub ?? null;

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((t) => {
      if (mode === 'mine' && t.owner_id !== myId) return false;
      if (q !== '') {
        const hay =
          `${fullName(t)} ${t.key_skills ?? ''} ${locationOf(t)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, mode, query, myId]);

  const truncated = items.length >= DEFAULT_LIST_CAP;

  const columns: ReadonlyArray<TableColumn<TalentRecordView>> = [
    {
      key: 'name',
      header: 'Talent',
      render: (t) => (
        <Link to={`/talent/${t.id}`} className="rc-link-strong">
          <EntityCell name={fullName(t)} hot={t.is_hot} />
        </Link>
      ),
    },
    {
      key: 'skills',
      header: 'Skills',
      render: (t) => <TagList tags={skillsOf(t)} max={3} />,
    },
    { key: 'location', header: 'Location', render: (t) => locationOf(t) },
    { key: 'rate', header: 'Rate (stated)', render: (t) => statedRate(t) },
  ];

  return (
    <section>
      <div className="rc-viewhead">
        <div>
          <h1 className="rc-h1">Talent</h1>
          <p className="rc-sub">
            Tenant talent pool · {truncated ? `first ${DEFAULT_LIST_CAP}` : items.length} visible
          </p>
        </div>
        {canCreate ? (
          <div className="rc-viewhead__actions">
            <Link to="/talent/new">
              <Button variant="primary">New talent</Button>
            </Link>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : null}
      {truncated ? (
        <p role="status" data-testid="talent-cap-banner" className="rc-sub rc-mt-16">
          Showing the first {DEFAULT_LIST_CAP}. More may exist; cursor pagination
          is on the roadmap.
        </p>
      ) : null}

      <Card flush className="rc-mt-16">
        <Toolbar>
          <FilterChip active={mode === 'all'} onClick={() => setMode('all')}>
            All
          </FilterChip>
          <FilterChip active={mode === 'mine'} onClick={() => setMode('mine')}>
            My talent
          </FilterChip>
          <ScopedSearch
            placeholder="Search your talent"
            value={query}
            onChange={setQuery}
          />
        </Toolbar>
        {loading ? (
          <p className="rc-empty">Loading talent…</p>
        ) : (
          <DataTable<TalentRecordView>
            columns={columns}
            rows={filtered}
            rowKey={(t) => t.id}
            emptyMessage={
              items.length === 0
                ? 'No talent yet in this tenant pool.'
                : 'No talent matches these filters.'
            }
          />
        )}
        <p className="rc-footnote">
          Talent shown is your tenant’s consented pool. Aramo doesn’t support
          open-web talent search or bulk export — sourcing is a separate,
          consent-governed flow.
        </p>
      </Card>
    </section>
  );
}
