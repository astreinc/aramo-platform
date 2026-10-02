import { Button, Dialog, InlineAlert, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import type { PipelineStatus } from '../pipeline/types';
import { LastContactCell } from '../talent/components/LastContactCell';
import { listTalentMemberships } from '../talent/saved-list-api';
import { searchTalent } from '../talent/talent-api';
import { AVAILABILITY_LABELS, CONSENT_LABELS, fullName } from '../talent/talent-workspace';
import type { TalentRecordView } from '../talent/types';
import { Avatar, StagePill } from '../ui';
import { resolveUserNames } from '../users/users-api';

import type { RequisitionView } from './types';

// CRM-8 (ARAMO-TALENT-CRM-V1 §12) — the requisition-scoped Known Talent drawer.
// A COMPOSITION over already-live authority: the native talent search
// (GET /v1/talent-records, tenant-scoped at the authoritative query path), the
// CRM-4 last_contact + consent composition, CRM-3 saved-list membership, the
// current pipeline relationship, and the EXISTING Pipeline add authority. It
// does NOT redirect to global search and does NOT create a parallel CRM
// requisition-membership relation. "Source new talent" stays the Sourcing flow.
//
// §12.3/§20 — results carry FACTUAL fields and a "Matched on" factual-hit list
// ONLY: no numeric assessment, no ordering number, no opaque match percentage.
// §12.4 — Add-to-requisition reuses the existing add authority (which today does
// NOT consent-gate); this drawer neither adds FE-only consent denial nor
// resolves reserved PO ruling #1 — it preserves current behavior.

function requisitionChips(req: RequisitionView): string[] {
  const chips: string[] = [];
  if (req.title.trim() !== '') chips.push(req.title.trim());
  const loc = [req.city, req.state].filter((x) => x !== null && x !== '').join(', ');
  if (loc !== '') chips.push(loc);
  return chips;
}

export function KnownTalentDrawer({
  requisition,
  attachedTalentIds,
  canAddToRequisition,
  onClose,
  onAdded,
}: {
  readonly requisition: RequisitionView;
  readonly attachedTalentIds: readonly string[];
  readonly canAddToRequisition: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const sessionState = useSession();
  const session =
    sessionState.status === 'authenticated' ? sessionState.session : null;
  const myId = session?.sub ?? null;

  const [chips, setChips] = useState<readonly string[]>(() => requisitionChips(requisition));
  const [results, setResults] = useState<readonly TalentRecordView[]>([]);
  const [memberships, setMemberships] = useState<
    Record<string, ReadonlyArray<{ id: string; name: string; visibility: string }>>
  >({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [attached, setAttached] = useState<ReadonlySet<string>>(() => new Set(attachedTalentIds));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ paged: 'true', page_size: '25' });
      if (chips.length > 0) params.set('q', chips.join(' '));
      const page = await searchTalent(params);
      setResults(page.items);
      const ids = page.items.map((t) => t.id);
      const [mem, names] = await Promise.all([
        ids.length > 0 ? listTalentMemberships(ids) : Promise.resolve([]),
        resolveUserNames(),
      ]);
      const map: Record<string, ReadonlyArray<{ id: string; name: string; visibility: string }>> = {};
      for (const m of mem) map[m.item_id] = m.lists;
      setMemberships(map);
      setUserNames(names);
      setError(null);
    } catch {
      setError('Couldn’t search known talent. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [chips]);

  useEffect(() => {
    void search();
  }, [search]);

  async function addToReq(talentId: string): Promise<void> {
    try {
      await addTalentToPipeline(talentId, requisition.id);
      setAttached((prev) => new Set([...prev, talentId])); // reflect "On this requisition"
      setNotice('Added to this requisition.');
      onAdded();
    } catch {
      setNotice('Add to requisition failed — please try again.');
    }
  }

  // §12.3 "Matched on …" — FACTUAL hits only: the requisition-fact chips that
  // literally appear in the result's searchable fields. No numeric assessment
  // and no ordering ordinal (Tier-2 banned; see scripts/verify-vocabulary.sh).
  function matchedOn(t: TalentRecordView): string[] {
    const hay = `${fullName(t)} ${t.title ?? ''} ${t.key_skills ?? ''} ${t.city ?? ''} ${t.state ?? ''}`.toLowerCase();
    return chips.filter((c) => hay.includes(c.toLowerCase()));
  }

  const contextLine = [
    requisition.title,
    [requisition.city, requisition.state].filter((x) => x !== null && x !== '').join(', ') || null,
    requisition.work_arrangement,
  ]
    .filter((x) => x !== null && x !== '')
    .join(' · ');

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Known talent for ${requisition.title}`}
      description="Search your tenant’s known Talent for this requisition. Source new talent routes to Sourcing."
      size="lg"
    >
      <div className="rc-ktd">
        <div className="rc-ktd__head">
          <span className="rc-ktd__context">{contextLine}</span>
          {/* §12.5 — Source new talent remains the Sourcing flow, unchanged. */}
          <Link to="/sourcing" className="rc-link-action" onClick={onClose}>
            Source new talent →
          </Link>
        </div>

        {/* §12.2 — removable requisition-fact chips. */}
        <div className="rc-ktd__chips">
          {chips.map((c) => (
            <Button
              unstyled
              key={c}
              type="button"
              className="rc-ktd__chip"
              aria-label={`Remove filter ${c}`}
              onClick={() => setChips((prev) => prev.filter((x) => x !== c))}
            >
              {c} ×
            </Button>
          ))}
          {chips.length === 0 ? (
            <span className="rc-muted">All known talent (no filters)</span>
          ) : null}
        </div>

        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        {notice !== null ? (
          <p role="status" className="rc-notice">
            {notice}
          </p>
        ) : null}

        <div className="rc-ktd__body">
          {loading ? (
            <p className="rc-empty">Searching known talent…</p>
          ) : results.length === 0 ? (
            <p className="rc-empty">No known talent matched these criteria.</p>
          ) : (
            results.map((t) => {
              const hits = matchedOn(t);
              const onReq = attached.has(t.id);
              const lists = memberships[t.id] ?? [];
              return (
                <div key={t.id} className="rc-ktd__row">
                  <span className="rc-ktd__who">
                    <Avatar name={fullName(t)} />
                    <span className="rc-ktd__nm">
                      {fullName(t)}
                      {t.title !== null ? <small>{t.title}</small> : null}
                    </span>
                  </span>
                  <span className="rc-ktd__facts">
                    <span>
                      {[t.city, t.state].filter((x) => x !== null && x !== '').join(', ') || '—'}
                    </span>
                    <span>
                      {t.availability_status !== null
                        ? (AVAILABILITY_LABELS[t.availability_status] ?? t.availability_status)
                        : '—'}
                    </span>
                    <span>{CONSENT_LABELS[t.consent_summary ?? 'do_not_contact']}</span>
                    {t.current_stage != null ? (
                      <StagePill status={t.current_stage.stage as PipelineStatus} />
                    ) : null}
                  </span>
                  <LastContactCell
                    last={t.last_contact ?? null}
                    userNames={userNames}
                    myId={myId}
                  />
                  <span className="rc-ktd__lists">
                    {lists.length === 0 ? (
                      <span className="rc-muted">—</span>
                    ) : (
                      lists.map((l) => (
                        <span key={l.id} className="rc-ktd__listtag">
                          {l.name}
                        </span>
                      ))
                    )}
                  </span>
                  {hits.length > 0 ? (
                    <span className="rc-ktd__matched">Matched on: {hits.join(', ')}</span>
                  ) : (
                    <span className="rc-ktd__matched rc-muted">Matched on: known talent</span>
                  )}
                  <span className="rc-ktd__action">
                    {/* §12.4 — mutually exclusive: never expose a duplicate add. */}
                    {onReq ? (
                      <span className="rc-ktd__onreq">✓ On this requisition</span>
                    ) : canAddToRequisition ? (
                      <Button type="button" onClick={() => void addToReq(t.id)}>
                        Add to requisition
                      </Button>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="rc-ktd__foot">
          {results.length} known · ordered by search relevance
        </div>
      </div>
    </Dialog>
  );
}
