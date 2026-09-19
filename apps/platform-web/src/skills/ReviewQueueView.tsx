import { useCallback, useMemo, useState } from 'react';
import {
  Button,
  CursorLoadMore,
  DataTable,
  InlineAlert,
  hasScope,
  useCursorPager,
  type CursorPage,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  skillsApi,
  type ReviewQueueRow,
  type ReviewQueueSourceDomain,
} from './skills-api';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { SkillFormDialog } from './skill-form-dialogs';
import { AliasFromSurfaceDialog } from './AliasFromSurfaceDialog';

const PAGE_LIMIT = 50;

interface AppliedFilters {
  sourceDomain: '' | ReviewQueueSourceDomain;
  minOccurrence: string;
  surfaceSearch: string;
}

const EMPTY_FILTERS: AppliedFilters = { sourceDomain: '', minOccurrence: '', surfaceSearch: '' };

// SKILL-TAX-1F-C2 — the unresolved-surface review queue. Counts-only rows
// (surface_form / occurrence_count / tenant_count) — no tenant/Talent/requisition
// identity is fetched or shown. Keyset pagination via the fe-foundation CursorPager
// (the cursor is opaque; the browser never decodes it). Manage-scope operators can
// turn a reviewed surface into a canonical skill, or attach it as an alias of a
// HUMAN-chosen existing skill — there is no automatic canonical-destination guess.
export function ReviewQueueView({ session }: { readonly session: Session }) {
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  // Draft (input) vs applied (committed on submit) filters — applied drives the pager.
  const [draft, setDraft] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [createFrom, setCreateFrom] = useState<string | null>(null);
  const [aliasFrom, setAliasFrom] = useState<string | null>(null);

  const resetKey = JSON.stringify(applied);
  const fetchPage = useCallback(
    async (cursor: string | null): Promise<CursorPage<ReviewQueueRow>> => {
      const page = await skillsApi.listReviewQueue({
        sourceDomain: applied.sourceDomain || undefined,
        minOccurrence: applied.minOccurrence !== '' ? Number(applied.minOccurrence) : undefined,
        surfaceSearch: applied.surfaceSearch || undefined,
        limit: PAGE_LIMIT,
        cursor,
      });
      return { items: page.rows, next_cursor: page.next_cursor };
    },
    [applied],
  );

  const pager = useCursorPager<ReviewQueueRow>(fetchPage, resetKey);

  const columns = useMemo<ReadonlyArray<TableColumn<ReviewQueueRow>>>(() => {
    const base: Array<TableColumn<ReviewQueueRow>> = [
      { key: 'surface_form', header: 'Unresolved surface', render: (r) => <span className="mono">{r.surface_form}</span> },
      { key: 'occurrence_count', header: 'Occurrences', render: (r) => <span className="num">{r.occurrence_count}</span> },
      { key: 'tenant_count', header: 'Tenants', render: (r) => <span className="num">{r.tenant_count}</span> },
    ];
    if (canManage) {
      base.push({
        key: 'actions',
        header: '',
        render: (r) => (
          <span className="pw-actions" style={{ margin: 0 }}>
            <Button variant="ghost" onClick={() => setCreateFrom(r.surface_form)}>Create skill</Button>
            <Button variant="ghost" onClick={() => setAliasFrom(r.surface_form)}>Add as alias…</Button>
          </span>
        ),
      });
    }
    return base;
  }, [canManage]);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Review queue</h1>
      </div>

      <form
        className="pw-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <select
          aria-label="Source domain"
          className="tc-input"
          value={draft.sourceDomain}
          onChange={(e) => setDraft({ ...draft, sourceDomain: e.target.value as AppliedFilters['sourceDomain'] })}
          style={{ minWidth: 160 }}
        >
          <option value="">All domains</option>
          <option value="talent">talent</option>
          <option value="requisition">requisition</option>
        </select>
        <input
          aria-label="Minimum occurrences"
          className="tc-input"
          type="number"
          min={0}
          placeholder="Min occurrences"
          value={draft.minOccurrence}
          onChange={(e) => setDraft({ ...draft, minOccurrence: e.target.value })}
          style={{ minWidth: 140 }}
        />
        <input
          aria-label="Surface search"
          className="tc-input"
          placeholder="Search surface…"
          value={draft.surfaceSearch}
          onChange={(e) => setDraft({ ...draft, surfaceSearch: e.target.value })}
          style={{ minWidth: 200 }}
        />
        <Button variant="secondary" type="submit">Apply</Button>
      </form>

      {pager.error ? <InlineAlert variant="error">{pager.error}</InlineAlert> : null}

      <DataTable
        columns={columns}
        rows={[...pager.items]}
        rowKey={(r) => r.surface_form}
        emptyMessage={pager.loading ? 'Loading…' : 'No unresolved surfaces match.'}
      />
      {pager.items.length > 0 || !pager.loading ? (
        <CursorLoadMore hasMore={pager.hasMore} loading={pager.loading} onLoadMore={pager.loadMore} />
      ) : null}

      {createFrom !== null ? (
        <SkillFormDialog
          mode="create"
          initialName={createFrom}
          open
          onOpenChange={(o) => !o && setCreateFrom(null)}
          onDone={() => {
            setCreateFrom(null);
            pager.reload();
          }}
        />
      ) : null}
      {aliasFrom !== null ? (
        <AliasFromSurfaceDialog
          surface={aliasFrom}
          open
          onOpenChange={(o) => !o && setAliasFrom(null)}
          onDone={() => {
            setAliasFrom(null);
            pager.reload();
          }}
        />
      ) : null}
    </div>
  );
}
