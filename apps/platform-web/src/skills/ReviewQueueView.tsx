import { useCallback, useEffect, useState } from 'react';
import { Button, Input, hasScope, useCursorPager, useOptionalToast, type CursorPage, type Session } from '@aramo/fe-foundation';

import { SegmentedFilter, SkeletonPanel, type SegmentOption } from '../components';

import { skillsApi, type ReviewQueueRow, type ReviewQueueSourceDomain } from './skills-api';
import { DOMAIN_LABEL } from './skill-labels';
import { useSkillDirectory } from './skill-directory';
import { AliasFromSurfaceDialog, CreateSkillDialog } from './skill-dialogs';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { SkillsPageHead, SkillsViewOnly } from './skills-chrome';

export const QUEUE_PAGE_SIZE = 50;

type DomainFilter = 'ALL' | ReviewQueueSourceDomain;

const DOMAIN_OPTIONS: readonly SegmentOption<DomainFilter>[] = [
  { value: 'ALL', label: 'All' },
  { value: 'talent', label: 'Talent' },
  { value: 'requisition', label: 'Requisition' },
];

/** The footer's left text: "Showing N · more available · 50 per page". */
export function queueFooterLine(shown: number, hasMore: boolean): string {
  return `Showing ${shown}${hasMore ? ' · more available' : ''} · ${QUEUE_PAGE_SIZE} per page`;
}

/** Keeps a typed value for `ms` before it becomes the applied filter. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// PLATFORM-UX-1 F-7 — Skills review queue (handoff §9; directive R-9). Rows are
// counts only: surface form, occurrences, tenants — never a tenant, talent or
// requisition identity. "First seen" is dropped (not in the response). The
// rows merge every in-scope domain, so Domain shows the filtered domain, or
// "—" under All. Keyset paging through the opaque cursor ("Load more").
export function ReviewQueueView({ session }: { readonly session: Session }) {
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const toast = useOptionalToast();
  const directory = useSkillDirectory();
  const [domain, setDomain] = useState<DomainFilter>('ALL');
  const [minText, setMinText] = useState('1');
  const [q, setQ] = useState('');
  const appliedMin = useDebounced(minText, 300);
  const appliedQ = useDebounced(q, 300);
  const [aliasFrom, setAliasFrom] = useState<string | null>(null);
  const [createFrom, setCreateFrom] = useState<string | null>(null);

  const minOccurrence = Math.max(1, Number.parseInt(appliedMin, 10) || 1);
  const search = appliedQ.trim();
  const resetKey = JSON.stringify([domain, minOccurrence, search]);
  const fetchPage = useCallback(
    async (cursor: string | null): Promise<CursorPage<ReviewQueueRow>> => {
      const page = await skillsApi.listReviewQueue({
        sourceDomain: domain === 'ALL' ? undefined : domain,
        minOccurrence,
        surfaceSearch: search.length > 0 ? search : undefined,
        limit: QUEUE_PAGE_SIZE,
        cursor,
      });
      return { items: page.rows, next_cursor: page.next_cursor };
    },
    [domain, minOccurrence, search],
  );
  const pager = useCursorPager<ReviewQueueRow>(fetchPage, resetKey);
  const firstLoad = pager.loading && pager.items.length === 0;
  const domainLabel = domain === 'ALL' ? '—' : DOMAIN_LABEL[domain];

  return (
    <div className="pw-sk">
      <SkillsPageHead
        title="Skills review queue"
        lede="Surface forms seen in tenant data that don't resolve to a skill yet."
      />
      {!canManage ? (
        <SkillsViewOnly what="Adding aliases and creating skills" className="pw-sk-viewonly-below" />
      ) : null}

      <div className="pw-sk-toolbar pw-sk-toolbar--queue">
        <SegmentedFilter label="Domain" options={DOMAIN_OPTIONS} value={domain} onChange={setDomain} />
        <label className="pw-sk-min">
          Min. occurrences
          <Input
            unstyled
            className="pw-input"
            type="number"
            min={1}
            value={minText}
            onChange={(e) => setMinText(e.target.value)}
          />
        </label>
        <Input
          unstyled
          className="pw-input pw-sk-search pw-sk-search--queue"
          aria-label="Search surface forms"
          placeholder="Search surface forms"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {pager.error ? (
        <div role="alert" className="pw-alert pw-alert--error pw-sk-alert">
          {pager.error}
        </div>
      ) : null}

      <div className="pw-sk-card">
        {firstLoad ? (
          <div className="pw-sk-loading">
            <SkeletonPanel lines={['100%', '92%', '96%', '88%']} label="Loading the review queue…" />
          </div>
        ) : (
          <>
            <div className="pw-sk-scroll">
              <table className="pw-sk-table pw-sk-table--queue">
                <thead>
                  <tr>
                    <th scope="col">Surface form</th>
                    <th scope="col">Domain</th>
                    <th scope="col" className="pw-sk-right">
                      Occurrences
                    </th>
                    <th scope="col" className="pw-sk-right">
                      Tenants
                    </th>
                    <th scope="col">
                      <span className="pw-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pager.items.map((r) => (
                    <tr key={r.surface_form}>
                      <td className="pw-sk-cell-surface">“{r.surface_form}”</td>
                      <td>{domainLabel}</td>
                      <td className="pw-sk-right">{r.occurrence_count}</td>
                      <td className="pw-sk-right">{r.tenant_count}</td>
                      <td className="pw-sk-cell-actions">
                        {canManage ? (
                          <span className="pw-sk-rowactions">
                            <Button
                              unstyled
                              className="pw-btn pw-btn--normal pw-btn--30"
                              onClick={() => setAliasFrom(r.surface_form)}
                            >
                              Add as alias…
                            </Button>
                            <Button
                              unstyled
                              className="pw-btn pw-btn--secondary pw-btn--30"
                              aria-label={`Create skill from “${r.surface_form}”`}
                              onClick={() => setCreateFrom(r.surface_form)}
                            >
                              Create skill
                            </Button>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pager.items.length === 0 && !pager.loading ? (
              <div className="pw-sk-empty">Nothing waiting at this threshold.</div>
            ) : null}
          </>
        )}
        <div className="pw-sk-foot">
          <span>{queueFooterLine(pager.items.length, pager.hasMore)}</span>
          {pager.hasMore && !firstLoad ? (
            <Button
              unstyled
              className="pw-btn pw-btn--secondary pw-btn--30 pw-sk-more"
              disabled={pager.loading}
              aria-busy={pager.loading || undefined}
              onClick={pager.loadMore}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>

      {aliasFrom !== null ? (
        <AliasFromSurfaceDialog
          open
          onOpenChange={(o) => {
            if (!o) setAliasFrom(null);
          }}
          surface={aliasFrom}
          directory={directory}
          onAdded={(skillId) => {
            toast.show(`“${aliasFrom}” added to ${directory.nameOf(skillId) ?? 'the skill'}.`);
            pager.reload();
          }}
        />
      ) : null}
      {createFrom !== null ? (
        <CreateSkillDialog
          open
          onOpenChange={(o) => {
            if (!o) setCreateFrom(null);
          }}
          initialName={createFrom}
          onCreated={(created) => {
            toast.show(`Skill “${created.canonical_name}” created.`);
            directory.reload();
            pager.reload();
          }}
        />
      ) : null}
    </div>
  );
}
