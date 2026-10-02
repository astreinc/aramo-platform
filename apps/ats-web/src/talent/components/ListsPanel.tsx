import {
  Button,
  Dialog,
  InlineAlert,
  Select,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { addTalentToPipeline } from '../../pipeline/pipeline-api';
import { listRequisitions } from '../../requisitions/requisitions-api';
import type { RequisitionView } from '../../requisitions/types';
import { Avatar, Card, Icons, StagePill } from '../../ui';
import type { PipelineStatus } from '../../pipeline/types';
import { resolveUserNames } from '../../users/users-api';
import {
  getSavedList,
  listTalentSavedLists,
  removeSavedListEntry,
  type SavedListRowView,
  type SavedListVisibility,
} from '../saved-list-api';
import { searchTalent } from '../talent-api';
import { AVAILABILITY_LABELS, CONSENT_LABELS, fullName } from '../talent-workspace';
import type { TalentRecordView } from '../types';

import { LastContactCell } from './LastContactCell';

// CRM-3 — the in-tab Lists surface (prototype Talent CRM.dc.html §7.1/§7.3):
// an INDEX (five columns) that opens a DETAIL (list members). All authority is
// backend: visibility-scoped reads, member_count aggregate, batch Talent read
// via the ?ids= allowlist (no N+1), governed pipeline-add for "Add to
// requisition", and Remove deletes only the membership entry. Last-contacted is
// CRM-4 (rendered "—", never proxied). "Edit list" (needs a PATCH route) and the
// detail "+ Add talent" reverse-add flow are deferred residuals — not faked here.

const VIS_LABEL: Record<SavedListVisibility, string> = {
  private: 'Private to me',
  tenant: 'Shared with tenant',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ListsPanel({
  sessionOverride,
}: {
  readonly sessionOverride?: Session;
} = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canManageLists =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'saved-list:edit');
  const canAddToReq =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'pipeline:add');

  const [lists, setLists] = useState<readonly SavedListRowView[]>([]);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // null = index view; otherwise the open list id.
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    list: SavedListRowView;
    entryByTalent: Record<string, string>; // talent_id → entry id
    talent: readonly TalentRecordView[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reqTarget, setReqTarget] = useState<string | null>(null);

  const loadIndex = useCallback(async () => {
    setLoading(true);
    try {
      const [items, names] = await Promise.all([listTalentSavedLists(), resolveUserNames()]);
      setLists(items);
      setOwners(names);
      setError(null);
    } catch {
      setError('Couldn’t load lists. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const list = await getSavedList(id);
      const ids = list.entries.map((e) => e.item_id);
      const entryByTalent: Record<string, string> = {};
      for (const e of list.entries) entryByTalent[e.item_id] = e.id;
      let talent: readonly TalentRecordView[] = [];
      if (ids.length > 0) {
        const params = new URLSearchParams({ paged: 'true', ids: ids.join(','), page_size: '200' });
        talent = (await searchTalent(params)).items;
      }
      setDetail({ list, entryByTalent, talent });
      setError(null);
    } catch {
      setError('Couldn’t load the list. Please try again.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (openId !== null) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  async function removeMember(talentId: string): Promise<void> {
    if (openId === null || detail === null) return;
    const entryId = detail.entryByTalent[talentId];
    if (entryId === undefined) return;
    try {
      await removeSavedListEntry(openId, entryId);
      setNotice('Removed from the list.');
      await loadDetail(openId);
    } catch {
      setError('Couldn’t remove from the list. Please try again.');
    }
  }

  async function addToReq(req: RequisitionView): Promise<void> {
    if (reqTarget === null) return;
    try {
      await addTalentToPipeline(reqTarget, req.id);
      setNotice(`Added to ${req.title}.`);
    } catch {
      setNotice('Add to requisition failed — please try again.');
    } finally {
      setReqTarget(null);
    }
  }

  // ── DETAIL ───────────────────────────────────────────────────────────────
  if (openId !== null) {
    const list = detail?.list ?? null;
    return (
      <>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        {notice !== null ? (
          <p role="status" className="rc-notice">
            {notice}
          </p>
        ) : null}
        <div className="rc-listdetail__head">
          <Button unstyled type="button" className="rc-listdetail__back" onClick={() => setOpenId(null)}>
            <Icons.IconChevronLeft /> Lists
          </Button>
          {list !== null ? (
            <div className="rc-listdetail__meta">
              <h2 className="rc-listdetail__name">{list.name}</h2>
              {list.purpose !== null ? <p className="rc-listdetail__purpose">{list.purpose}</p> : null}
              <div className="rc-listdetail__facts">
                <span>{VIS_LABEL[list.visibility]}</span>
                <span>{list.member_count ?? detail?.talent.length ?? 0} people</span>
                <span>Created by {owners[list.owner_id] ?? '—'}</span>
                <span>Updated {fmtDate(list.updated_at)}</span>
              </div>
            </div>
          ) : null}
        </div>

        <Card flush>
          <div className="rc-listdetailtbl">
            <div className="rc-listdetailtbl__head" role="row">
              <span role="columnheader">Talent</span>
              <span role="columnheader">Availability</span>
              <span role="columnheader">Last contacted</span>
              <span role="columnheader">Permission</span>
              <span role="columnheader">Activity</span>
              <span role="columnheader" aria-label="Actions" />
            </div>
            <div className="rc-listdetailtbl__body">
              {detailLoading ? (
                <p className="rc-empty">Loading…</p>
              ) : detail === null || detail.talent.length === 0 ? (
                <p className="rc-empty">This list has no talent yet.</p>
              ) : (
                detail.talent.map((t) => (
                  <div key={t.id} className="rc-listdetailtbl__row" role="row">
                    <span className="rc-ldt__talent">
                      <Avatar name={fullName(t)} />
                      <span className="rc-ldt__nm">
                        {fullName(t)}
                        {t.title !== null ? <small>{t.title}</small> : null}
                      </span>
                    </span>
                    <span>
                      {t.availability_status !== null
                        ? (AVAILABILITY_LABELS[t.availability_status] ?? t.availability_status)
                        : '—'}
                    </span>
                    {/* CRM-4 — authoritative last-contact; "Never" when none. */}
                    <LastContactCell
                      last={t.last_contact ?? null}
                      userNames={owners}
                      myId={session?.sub ?? null}
                    />
                    <span>{CONSENT_LABELS[t.consent_summary ?? 'do_not_contact']}</span>
                    <span>
                      {t.current_stage == null ? (
                        <span className="rc-muted">No active requisition</span>
                      ) : (
                        <StagePill status={t.current_stage.stage as PipelineStatus} />
                      )}
                    </span>
                    <span className="rc-ldt__actions">
                      {canAddToReq ? (
                        <Button type="button" onClick={() => setReqTarget(t.id)}>
                          Add to requisition
                        </Button>
                      ) : null}
                      {canManageLists ? (
                        <Button
                          type="button"
                          onClick={() => void removeMember(t.id)}
                          title="Remove from this list"
                        >
                          Remove
                        </Button>
                      ) : null}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>

        <ReqPickDialog
          open={reqTarget !== null}
          onClose={() => setReqTarget(null)}
          onPick={(r) => void addToReq(r)}
        />
      </>
    );
  }

  // ── INDEX ────────────────────────────────────────────────────────────────
  return (
    <>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {notice !== null ? (
        <p role="status" className="rc-notice">
          {notice}
        </p>
      ) : null}
      <Card flush>
        <div className="rc-lists">
          <div className="rc-lists__head" role="row">
            <span role="columnheader">List</span>
            <span role="columnheader">Visibility</span>
            <span role="columnheader">People</span>
            <span role="columnheader">Created by</span>
            <span role="columnheader">Updated</span>
          </div>
          <div className="rc-lists__body">
            {loading ? (
              <p className="rc-empty">Loading lists…</p>
            ) : lists.length === 0 ? (
              <p className="rc-empty">No lists yet. Select talent and choose “Add to list”.</p>
            ) : (
              lists.map((l) => (
                <Button
                  unstyled
                  key={l.id}
                  type="button"
                  className="rc-lists__row"
                  onClick={() => setOpenId(l.id)}
                >
                  <span className="rc-lists__nm">
                    {l.name}
                    {l.purpose !== null ? <small>{l.purpose}</small> : null}
                  </span>
                  <span>{VIS_LABEL[l.visibility]}</span>
                  <span className="num">{l.member_count ?? 0}</span>
                  <span>{owners[l.owner_id] ?? '—'}</span>
                  <span>{fmtDate(l.updated_at)}</span>
                </Button>
              ))
            )}
          </div>
        </div>
      </Card>
    </>
  );
}

// Compact governed req-picker (reuses addTalentToPipeline via the parent). Lists
// only OPEN requisitions, mirroring the Talent-list add-to-req dialog.
function ReqPickDialog({
  open,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (req: RequisitionView) => void;
}) {
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [reqId, setReqId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setReqId('');
    void listRequisitions()
      .then((r) => {
        if (!cancelled) setReqs(r.items.filter((x) => x.status === 'open'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chosen = reqs.find((r) => r.id === reqId) ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to requisition"
      description="Add this talent to a requisition’s pipeline."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chosen === null}
            onClick={() => {
              if (chosen !== null) onPick(chosen);
            }}
          >
            Add to pipeline
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="rc-empty">Loading requisitions…</p>
      ) : (
        <Select value={reqId} onChange={(e) => setReqId(e.target.value)}>
          <option value="">Choose a requisition…</option>
          {reqs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </Select>
      )}
    </Dialog>
  );
}
