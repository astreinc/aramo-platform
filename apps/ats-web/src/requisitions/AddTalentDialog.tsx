import { useEffect, useRef, useState } from 'react';
import { ApiError, Button, Dialog, InlineAlert, useToast, Input } from '@aramo/fe-foundation';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { addTalentErrorMessage } from '../pipeline/error-messages';
import { searchTalentForPicker } from '../talent/talent-api';
import {
  ResumeChoiceField,
  ResumeChoiceRefused,
  saveResumeChoice,
  suggestedResumeId,
  useCanSetResume,
  useResumeChoices,
} from '../talent/add-resume-choice';
import type { TalentRecordView } from '../talent/types';
import { Avatar, Icons } from '../ui';

/** ATS-QA-1 D3 — keystroke debounce before the server search runs. */
export const ADD_TALENT_SEARCH_DEBOUNCE_MS = 300;

interface AddTalentDialogProps {
  readonly requisitionId: string;
  /** Talent with a LIVE episode on this requisition — shown as already on it, never addable. */
  readonly existingTalentIds: readonly string[];
  /** Pipeline & RTR Recon Remediation Directive v1.0 R3 (DEF-15(b)) — talent whose earlier episode
   *  on this requisition ended (not in consideration / completed): listed as "add again". */
  readonly endedTalentIds?: readonly string[];
  /** True when the actor holds pipeline:re-add (Recruiter Lead, Recruiting Manager, admin). Without
   *  it a previously-ended talent is shown but not addable (the server refuses regardless). */
  readonly canReAdd?: boolean;
  /** True when the actor holds talent:search (every pipeline:add role does — ATS-QA-1 §5). Without
   *  it the picker still pages the pool but the name search is unavailable (the server refuses ?q=). */
  readonly canSearch?: boolean;
  /** ATS-QA-1 1.1 — when set, the requisition cannot take talent in its current status: the
   *  button is disabled and this text says why (the server refuses regardless). */
  readonly disabledReason?: string | null;
  /** ATS-QA-1 I-5 — pipeline:resume:set. When omitted it is read from the session on first
   *  open. Without it there is no résumé choice (the add proceeds as before). */
  readonly canSetResume?: boolean;
  readonly onAdded: () => void;
}

// The mockup's primary header action. Opens a dialog over the tenant talent pool
// (POOL-OPEN). ATS-QA-1 D3 — the search and paging are SERVER-SIDE: the debounced
// name/title/skill/location term goes to GET /v1/talent-records?paged=true&q=
// (talent:search, existing tenant + site visibility) and "Show more" follows the
// keyset cursor. There is no client-side cap. Talent already live on this
// requisition are marked and cannot be added again. The chosen talent is added
// via POST /v1/pipelines (pipeline:add); the BE owns the initial status.
//
// ATS-QA-1 I-5 — picking a Talent with more than one active résumé (caller holding
// pipeline:resume:set) opens a résumé-choice step first; the chosen edition is written
// for this requisition right after the add. One résumé (or no scope): added at once.
export function AddTalentDialog({
  requisitionId,
  existingTalentIds,
  endedTalentIds = [],
  canReAdd = false,
  canSearch = true,
  disabledReason = null,
  canSetResume,
  onAdded,
}: AddTalentDialogProps) {
  const ended = new Set(endedTalentIds);
  const existing = new Set(existingTalentIds);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<readonly TalentRecordView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchDenied, setSearchDenied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const toast = useToast();
  // ATS-QA-1 I-5 — the Talent being added, while its résumé choices load / are chosen.
  const [pending, setPending] = useState<TalentRecordView | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [refusedOutcome, setRefusedOutcome] = useState<{ talentId: string; reason: string } | null>(null);
  const mayChooseResume = useCanSetResume(open, canSetResume);
  const resumeChoices = useResumeChoices(pending?.id ?? null, requisitionId, mayChooseResume);

  const searchAllowed = canSearch && !searchDenied;

  // A fresh open never shows a previous add's outcome or pending choice.
  useEffect(() => {
    if (!open) return;
    setPending(null);
    setResumeId(null);
    setRefusedOutcome(null);
  }, [open]);

  // Debounce the typed query into the server search term.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => setTerm(query.trim()), ADD_TALENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, open]);

  // First page for the current term (a new term replaces the list).
  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    searchTalentForPicker({ q: searchAllowed ? term : undefined })
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        if (err instanceof ApiError && err.status === 403 && term !== '') {
          // The server refused the name search (talent:search not held): say so honestly.
          setSearchDenied(true);
          return;
        }
        setItems([]);
        setNextCursor(null);
        setLoadError('Could not load talent. Try again.');
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [open, term, searchAllowed]);

  const loadMore = () => {
    if (nextCursor === null) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    searchTalentForPicker({ q: searchAllowed ? term : undefined, cursor: nextCursor })
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.next_cursor);
      })
      .catch(() => {
        if (seq === requestSeq.current) setLoadError('Could not load more talent. Try again.');
      })
      .finally(() => setLoadingMore(false));
  };

  const reset = () => {
    requestSeq.current += 1;
    setQuery('');
    setTerm('');
    setItems([]);
    setNextCursor(null);
    setError(null);
    setLoadError(null);
    setPending(null);
    setResumeId(null);
    setRefusedOutcome(null);
  };

  const add = async (talentId: string, editionId: string | null) => {
    setBusyId(talentId);
    setError(null);
    try {
      const pipeline = await addTalentToPipeline(talentId, requisitionId);
      // The add stands even if the résumé selection is refused.
      const refused = editionId === null ? null : await saveResumeChoice(pipeline.id, editionId);
      if (refused === null) {
        toast.show('Talent added to the pipeline.');
        setOpen(false);
        reset();
      } else {
        // Keep the dialog open on the outcome: the reason + where to choose the resume.
        setPending(null);
        setRefusedOutcome({ talentId, reason: refused });
      }
      onAdded();
    } catch (err) {
      // Remediation v1.0 R3 (DEF-14) — the server's typed refusal, never a guess.
      setError(addTalentErrorMessage(err));
      setPending(null);
    } finally {
      setBusyId(null);
    }
  };

  // ATS-QA-1 I-5 — a picked Talent with no choice to make (one résumé, none, or no
  // pipeline:resume:set) is added at once, exactly as before.
  useEffect(() => {
    if (pending === null || busyId !== null) return;
    // Only act on choices loaded for THIS talent (never a previous pick's state).
    if (resumeChoices.kind !== 'none' && resumeChoices.kind !== 'choose') return;
    if (resumeChoices.talentId !== pending.id) return;
    if (resumeChoices.kind === 'none') void add(pending.id, null);
    if (resumeChoices.kind === 'choose') setResumeId(suggestedResumeId(resumeChoices.choices));
    // Re-run only when the pick or its choice state changes.
  }, [pending, resumeChoices]);

  const blocked = disabledReason !== null && disabledReason !== '';
  const searching = term !== '' && searchAllowed;

  return (
    <>
      <Button
        unstyled
        className="rc-hbtn rc-hbtn--primary"
        onClick={() => setOpen(true)}
        disabled={blocked}
        title={blocked ? disabledReason : undefined}
        aria-describedby={blocked ? `add-talent-reason-${requisitionId}` : undefined}
      >
        <Icons.IconPlus />
        Add talent
      </Button>
      {blocked ? (
        <span id={`add-talent-reason-${requisitionId}`} className="rc-hbtn-sod">
          {disabledReason}
        </span>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title="Add talent"
        description="Add talent from your pool to this requisition's pipeline."
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {refusedOutcome !== null ? 'Done' : 'Close'}
          </Button>
        }
      >
        {refusedOutcome !== null ? (
          <>
            <InlineAlert variant="success">Talent added to the pipeline.</InlineAlert>
            <ResumeChoiceRefused
              reason={refusedOutcome.reason}
              requisitionId={requisitionId}
              talentId={refusedOutcome.talentId}
            />
          </>
        ) : pending !== null && resumeChoices.kind === 'choose' && resumeChoices.talentId === pending.id ? (
          <>
            <p className="rc-muted">
              Adding <strong>{`${pending.first_name} ${pending.last_name}`.trim()}</strong> to this requisition.
            </p>
            <ResumeChoiceField
              choices={resumeChoices.choices}
              value={resumeId}
              onChange={setResumeId}
              requisitionId={requisitionId}
              disabled={busyId !== null}
            />
            {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
            <div className="talent-detail__dialog-actions">
              <Button
                variant="primary"
                onClick={() => void add(pending.id, resumeId)}
                disabled={busyId !== null || resumeId === null}
              >
                {busyId !== null ? 'Adding…' : 'Add to requisition'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPending(null);
                  setResumeId(null);
                }}
                disabled={busyId !== null}
              >
                Back
              </Button>
            </div>
          </>
        ) : (
        <>
        {pending !== null ? <p className="rc-muted" role="status">Loading resumes…</p> : null}
        <label className="rc-field">
          <span className="rc-field__label">Search talent</span>
          <Input
            unstyled
            className="rc-select"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchAllowed ? 'Name, title, skill or location…' : 'Search is not available to you'}
            disabled={!searchAllowed}
            autoFocus
          />
        </label>
        {!searchAllowed ? (
          <p className="rc-empty" role="status">
            You don’t have permission to search talent. You can still browse the pool below.
          </p>
        ) : null}
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        {loadError !== null ? <InlineAlert variant="error">{loadError}</InlineAlert> : null}
        {loading ? (
          <p className="rc-empty">Loading talent…</p>
        ) : items.length === 0 ? (
          loadError !== null ? null : (
            <p className="rc-empty">
              {searching ? `No talent matches “${term}”.` : 'No talent in your pool yet.'}
            </p>
          )
        ) : (
          <>
            <ul className="rc-pick">
              {items.map((t) => {
                const name = `${t.first_name} ${t.last_name}`.trim();
                const isLive = existing.has(t.id);
                const reAddBlocked = ended.has(t.id) && !canReAdd;
                return (
                  <li key={t.id}>
                    <Button
                      unstyled
                      className="rc-pick__row"
                      onClick={() => setPending(t)}
                      disabled={busyId !== null || pending !== null || isLive || reAddBlocked}
                      title={
                        isLive
                          ? 'Already on this requisition'
                          : reAddBlocked
                            ? 'Only a Recruiter Lead, Recruiting Manager or admin can add this talent again'
                            : undefined
                      }
                    >
                      <Avatar name={name} size="sm" />
                      <span className="rc-pick__nm">{name}</span>
                      {isLive ? (
                        <span className="rc-pick__sub">Already on this requisition</span>
                      ) : ended.has(t.id) ? (
                        // R3 (DEF-15(b)) — a talent whose earlier episode here ended.
                        <span className="rc-pick__sub">
                          {canReAdd ? 'Previously on this requisition — add again' : 'Previously on this requisition'}
                        </span>
                      ) : null}
                      {t.key_skills != null && t.key_skills !== '' ? (
                        <span className="rc-pick__sub">{t.key_skills}</span>
                      ) : null}
                      {busyId === t.id ? (
                        <span className="rc-pick__busy">Adding…</span>
                      ) : isLive ? null : (
                        <Icons.IconPlus />
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {nextCursor !== null ? (
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </Button>
            ) : null}
          </>
        )}
        </>
        )}
      </Dialog>
    </>
  );
}

// ATS-QA-1 I-1 (QA 1.1) — why Add talent is unavailable on a not-yet-open requisition.
export function addTalentDisabledReason(status: string): string | null {
  if (status === 'draft') return 'Talent can be added once this requisition is open.';
  if (status === 'pending_approval') return 'Talent can be added once this requisition is approved.';
  return null;
}
