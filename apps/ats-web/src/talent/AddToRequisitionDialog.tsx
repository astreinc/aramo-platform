import { useEffect, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, Input, Select } from '@aramo/fe-foundation';

import { listCompanies } from '../companies/companies-api';
import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { addTalentErrorMessage } from '../pipeline/error-messages';
import { listRequisitionsForPicker } from '../requisitions/requisitions-api';
import type { RequisitionView } from '../requisitions/types';

import {
  ResumeChoiceField,
  ResumeChoiceRefused,
  saveResumeChoice,
  suggestedResumeId,
  useCanSetResume,
  useResumeChoices,
} from './add-resume-choice';

// ATS-QA-1 D4 — the ONE requisition picker the three add-to-requisition surfaces share
// (this dialog, the Lists detail and the Talent list bulk bar).
//
// - Statuses: A1 AM-1 §2.2 — Add Talent is permitted on open, on hold and lead
//   requisitions (the server re-checks).
// - SERVER-SIDE paging + search: GET /v1/requisitions?paged=true&status=…&q=&cursor=
//   (keyset; title OR REQ number; ANDed with the A3/D4b visibility predicate — narrows,
//   never widens). Every visible requisition is reachable through "Show more"; there is
//   no fixed cap.
// - Label: title · REQ-number · client name (client via the companies list join,
//   the RequisitionsListView precedent). An unresolved client is omitted, never guessed.
export const PICKER_REQUISITION_STATUSES: readonly string[] = ['open', 'on_hold', 'lead'];

/** Keystroke debounce before the server search runs. */
export const REQUISITION_SEARCH_DEBOUNCE_MS = 300;

export function requisitionOptionLabel(
  req: Pick<RequisitionView, 'title' | 'requisition_number'>,
  clientName: string | null | undefined,
): string {
  return [req.title, `REQ-${req.requisition_number}`, clientName ?? null]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join(' · ');
}

export function RequisitionPicker({
  open,
  value,
  onChange,
  canSearch = true,
}: {
  /** Load only while the host dialog is open. */
  readonly open: boolean;
  readonly value: RequisitionView | null;
  readonly onChange: (req: RequisitionView | null) => void;
  /** requisition:search held (all requisition:read holders in the seed). Without it the
   *  picker lists the default page and says search is unavailable. */
  readonly canSearch?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [searchDenied, setSearchDenied] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const searchAllowed = canSearch && !searchDenied;

  // Clear the search when the host dialog closes (the next open starts fresh).
  useEffect(() => {
    if (open) return;
    setQuery('');
    setTerm('');
  }, [open]);

  // Client names — one companies read per open (best-effort: a failure omits the client).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listCompanies()
      .then((r) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const c of r.items) map[c.id] = c.name;
        setClients(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => setTerm(query.trim()), REQUISITION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    setLoadErr(false);
    listRequisitionsForPicker({ statuses: PICKER_REQUISITION_STATUSES, ...(searchAllowed && term !== '' ? { q: term } : {}) })
      .then((r) => {
        if (mine !== seq.current) return;
        setReqs(r.items);
        setNextCursor(r.next_cursor);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        if (err instanceof ApiError && err.status === 403 && term !== '') {
          setSearchDenied(true);
          return;
        }
        setReqs([]);
        setLoadErr(true);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [open, term, searchAllowed]);

  const loadMore = (): void => {
    if (nextCursor === null || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    listRequisitionsForPicker({ statuses: PICKER_REQUISITION_STATUSES, cursor: nextCursor, ...(searchAllowed && term !== '' ? { q: term } : {}) })
      .then((r) => {
        if (mine !== seq.current) return;
        setReqs((prev) => [...prev, ...r.items.filter((x) => !prev.some((p) => p.id === x.id))]);
        setNextCursor(r.next_cursor);
      })
      .catch(() => {
        if (mine === seq.current) setLoadErr(true);
      })
      .finally(() => setLoadingMore(false));
  };

  // Keep the selection only while it is still in the shown set.
  useEffect(() => {
    if (value !== null && !reqs.some((r) => r.id === value.id)) onChange(null);
  }, [reqs, value, onChange]);

  return (
    <div>
      <label className="rc-field">
        <span className="rc-field__label">Search requisitions</span>
        <Input
          unstyled
          className="rc-select"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchAllowed ? 'Title or REQ number…' : 'Search is not available to you'}
          disabled={!searchAllowed}
          aria-label="Search requisitions"
        />
      </label>
      {!searchAllowed ? (
        <p className="rc-empty" role="status">
          You don’t have permission to search requisitions. The most recent ones are listed below.
        </p>
      ) : term === '' ? (
        <p className="rc-muted">Newest first. Type a title or REQ number to search every requisition you can see.</p>
      ) : null}
      {loading ? (
        <p className="rc-empty">Loading requisitions…</p>
      ) : loadErr ? (
        <InlineAlert variant="error">Couldn’t load requisitions. Please try again.</InlineAlert>
      ) : reqs.length === 0 ? (
        <p className="rc-empty">
          {term !== '' && searchAllowed
            ? `No open, on-hold or lead requisitions match “${term}”.`
            : 'No open, on-hold or lead requisitions visible to you.'}
        </p>
      ) : (
        <label className="rc-field">
          <span className="rc-field__label">Requisition</span>
          <Select
            unstyled
            className="rc-select"
            value={value?.id ?? ''}
            onChange={(e) => onChange(reqs.find((r) => r.id === e.target.value) ?? null)}
            aria-label="Requisition"
          >
            <option value="">Choose a requisition…</option>
            {reqs.map((r) => (
              <option key={r.id} value={r.id}>
                {requisitionOptionLabel(r, clients[r.company_id])}
              </option>
            ))}
          </Select>
          {nextCursor !== null ? (
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore} data-testid="requisition-picker-more">
              {loadingMore ? 'Loading…' : 'Show more requisitions'}
            </Button>
          ) : null}
        </label>
      )}
    </div>
  );
}

// Add-to-requisition dialog — extracted from TalentDetailView so both the
// Talent Detail surface and Talent 360 reuse the SAME flow (the sanctioned
// pipeline-add path: RequisitionPicker → addTalentToPipeline). No business
// logic is cloned; this is the one shared dialog.
//
// ATS-QA-1 I-5 — once a requisition is chosen, a caller holding pipeline:resume:set
// sees the résumé choice when the Talent has more than one active edition
// (add-resume-choice.tsx); the chosen edition is written right after the add.
export function AddToRequisitionDialog({
  open,
  onClose,
  talentId,
  canSearch = true,
  canSetResume,
}: {
  open: boolean;
  onClose: () => void;
  talentId: string;
  canSearch?: boolean;
  /** pipeline:resume:set — when omitted it is read from the session on first open. */
  canSetResume?: boolean;
}) {
  const [chosen, setChosen] = useState<RequisitionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  // Remediation v1.0 R3 (DEF-11) — "already on this requisition" is NOT a success.
  const [alreadyOn, setAlreadyOn] = useState(false);
  const mayChooseResume = useCanSetResume(open, canSetResume);
  const resumeChoices = useResumeChoices(open && chosen !== null ? talentId : null, chosen?.id ?? null, mayChooseResume);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [resumeRefused, setResumeRefused] = useState<string | null>(null);
  const [addedReqId, setAddedReqId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAdded(false);
    setAlreadyOn(false);
    setActionErr(null);
    setChosen(null);
    setResumeRefused(null);
    setAddedReqId(null);
  }, [open]);

  // Preselect the Talent's suggested default each time the choices load.
  useEffect(() => {
    setResumeId(resumeChoices.kind === 'choose' ? suggestedResumeId(resumeChoices.choices) : null);
  }, [resumeChoices]);

  const onAdd = () => {
    if (chosen === null) return;
    const editionToSave = resumeChoices.kind === 'choose' ? resumeId : null;
    setBusy(true);
    setActionErr(null);
    setResumeRefused(null);
    addTalentToPipeline(talentId, chosen.id)
      .then(async (pipeline) => {
        // The add stands even if the résumé selection is refused.
        if (editionToSave !== null) {
          setResumeRefused(await saveResumeChoice(pipeline.id, editionToSave));
        }
        setAddedReqId(chosen.id);
        setBusy(false);
        setAdded(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        // Pipeline & RTR Recon Remediation Directive v1.0 R3 (DEF-11) — a refusal is never shown
        // as "added": the server's typed refusal is stated as it is.
        if ((err as { code?: string } | null)?.code === 'PIPELINE_EPISODE_ALREADY_LIVE') {
          setAlreadyOn(true);
          return;
        }
        setActionErr(addTalentErrorMessage(err));
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to requisition"
    >
      {alreadyOn ? (
        <>
          <p className="talent-detail__empty" role="status">This talent is already on this requisition. Nothing was changed.</p>
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </>
      ) : added ? (
        <>
          <InlineAlert variant="success">Talent added to the requisition.</InlineAlert>
          {resumeRefused !== null && addedReqId !== null ? (
            <ResumeChoiceRefused reason={resumeRefused} requisitionId={addedReqId} talentId={talentId} />
          ) : null}
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <RequisitionPicker open={open} value={chosen} onChange={setChosen} canSearch={canSearch} />
          {resumeChoices.kind === 'loading' ? <p className="rc-muted">Loading resumes…</p> : null}
          {resumeChoices.kind === 'choose' ? (
            <ResumeChoiceField
              choices={resumeChoices.choices}
              value={resumeId}
              onChange={setResumeId}
              requisitionId={chosen?.id ?? null}
              disabled={busy}
            />
          ) : null}
          {actionErr !== null ? (
            <InlineAlert variant="error">{actionErr}</InlineAlert>
          ) : null}
          <div className="talent-detail__dialog-actions">
            <Button
              variant="primary"
              onClick={onAdd}
              disabled={
                chosen === null ||
                busy ||
                resumeChoices.kind === 'loading' ||
                (resumeChoices.kind === 'choose' && resumeId === null)
              }
            >
              {busy ? 'Adding…' : 'Add to requisition'}
            </Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
