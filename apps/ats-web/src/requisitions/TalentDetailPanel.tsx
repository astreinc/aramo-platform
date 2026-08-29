import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, FUNNEL_BUCKETS, funnelBucket, HotToggle, type FunnelBucketKey } from '../ui';
import { InlineEditField, InlineSelectField } from '../components/InlineEditField';
import { legalNextStates } from '../pipeline/legal-transitions';
import { transitionPipeline } from '../pipeline/pipeline-api';
import {
  PIPELINE_NEXT_ACTION,
  type PipelineStatus,
  type PipelineView,
} from '../pipeline/types';
import { OfferPanelContainer } from '../offers/OfferPanelContainer';
import { getTalent, updateTalent } from '../talent/talent-api';
import type { TalentRecordView, UpdateTalentRecordRequest } from '../talent/types';
import {
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
  type WorkAuthorization,
} from '../talent/stated-fields';

// Inline-edit is gated on talent:edit and writes the REAL talent-record columns
// via PATCH /v1/talent-records/:id (updateTalent, UpdateTalentRecordRequestDto).
// Editable columns: first_name, last_name, email1, phone_cell, city, state,
// work_authorization (enum → select), desired_pay. Agreed pay rate is NOT here
// (a placement/assignment value, not a talent-record column). Values are sourced
// from the RAW record (getTalent → full TalentRecordView), never the list
// enrichment; the enrichment stays the read-only (no-edit) presentation.
const WORK_AUTH_OPTIONS = WORK_AUTHORIZATION_VALUES.map((v) => ({
  value: v,
  label: WORK_AUTHORIZATION_LABELS[v],
}));

// REQ talent slide-in detail panel. Opens from a talent card in a requisition's
// expanded row. The workflow stepper is a COSMETIC affordance over the governed
// pipeline lifecycle: a stage is clickable only when it is a legal next
// transition (legalNextStates, the FE mirror of the BE matrix), and the backend
// `/v1/pipelines/:id/transition` remains the authority (a rejected move surfaces
// an error, never a silent bypass). So "Placed" cannot be reached except from
// "offer", preserving the offer→placement governance.

// The status a click on each funnel bucket transitions TO (the bucket's canonical
// forward status). Legality is gated by legalNextStates, so a bucket whose target is
// not a legal next state renders DISABLED. L2-F3 — `interviewing` is RETIRED as a
// Pipeline transition target (interview truth is owned by InterviewSession), so the
// `interview` bucket is now DISPLAY-ONLY: `legalNextStates` never yields `interviewing`,
// so the bucket button is always disabled (no forward write) — it renders only to place
// legacy `interviewing` rows on the funnel. The mapping is retained so the bucket keeps
// its canonical position; it is inert as a write.
const BUCKET_TARGET: Record<FunnelBucketKey, PipelineStatus> = {
  sourced: 'contacted',
  qualifying: 'qualifying',
  submitted: 'submitted',
  interview: 'interviewing',
  offer: 'offered',
  placed: 'placed',
};
const BUCKET_INDEX: Record<string, number> = Object.fromEntries(
  FUNNEL_BUCKETS.map((b, i) => [b.key, i]),
);

export interface TalentDetailPanelProps {
  readonly entry: PipelineView;
  readonly talentName: string | undefined;
  readonly isNew: boolean;
  readonly reqTitle: string;
  readonly reqCode: string; // e.g. "REQ-2041"
  readonly scopes: readonly string[];
  readonly onClose: () => void;
  readonly onTransitioned: (updated: PipelineView) => void;
  // Per Option-A ruling — the row-level HOT triage moves OFF the journey grid
  // and INTO this owning surface. Optional so the list-expander call site is
  // unaffected; the toggle renders only when a handler is supplied.
  readonly isHot?: boolean;
  readonly canEditHot?: boolean;
  readonly onToggleHot?: (next: boolean) => void;
  // A successful inline field save reports an ENRICHMENT-shaped patch
  // ({email}/{phone}/{location:"City, ST"}/{work_auth}/{desired_rate}) so the
  // owner (the requisitions list) can reflect the new value in the read-only
  // extender without a refetch. Optional — call sites that don't own list state
  // simply omit it.
  readonly onTalentFieldSaved?: (
    talentRecordId: string,
    enrichmentPatch: Partial<PipelineView>,
  ) => void;
}

export function TalentDetailPanel({
  entry,
  talentName,
  isNew,
  reqTitle,
  reqCode,
  scopes,
  onClose,
  onTransitioned,
  isHot = false,
  canEditHot = false,
  onToggleHot,
  onTalentFieldSaved,
}: TalentDetailPanelProps): JSX.Element {
  const [record, setRecord] = useState<TalentRecordView | null>(null);
  const [busy, setBusy] = useState<FunnelBucketKey | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The RAW talent record (full TalentRecordView) — the SOURCE for inline edit.
  useEffect(() => {
    let cancelled = false;
    void getTalent(entry.talent_record_id)
      .then((t) => {
        if (!cancelled) setRecord(t);
      })
      .catch(() => {
        /* names fall back to the passed talentName / — */
      });
    return () => {
      cancelled = true;
    };
  }, [entry.talent_record_id]);

  // talent:edit gates editability (the BE PATCH is authoritative). Without it,
  // the fields stay the read-only enrichment display.
  const canEditTalent = scopes.includes('talent:edit');

  // Optimistic single-column PATCH with rollback. On failure the previous record
  // is restored and the error re-thrown so InlineEditField surfaces a controlled
  // inline message (never raw backend text) and keeps the editor open. On success
  // the ENRICHMENT-shaped patch (if given) is reported upward so the shared list
  // state reflects the new value in the read-only extender.
  const patchColumn = async (
    body: UpdateTalentRecordRequest,
    optimistic: Partial<TalentRecordView>,
    enrichmentPatch?: Partial<PipelineView>,
  ): Promise<void> => {
    const prev = record;
    setRecord(prev === null ? prev : ({ ...prev, ...optimistic } as TalentRecordView));
    try {
      const updated = await updateTalent(entry.talent_record_id, body);
      setRecord(updated);
      if (enrichmentPatch !== undefined) {
        onTalentFieldSaved?.(entry.talent_record_id, enrichmentPatch);
      }
    } catch (e) {
      setRecord(prev);
      throw e;
    }
  };

  // Enrichment-fallback SOURCES for the editors. The raw record read
  // (getTalent → GET /v1/talent-records/:id) is @RequireSiteMatch and may 404
  // (record null) — the working enrichment carried on `entry` (tenant-scoped,
  // masked) is the fallback so an EXISTING value always shows; a genuinely-empty
  // field stays blank AND editable.
  const parsedLoc = parseLocation(entry.location ?? null);
  const loc = {
    city: record?.city ?? parsedLoc.city,
    state: record?.state ?? parsedLoc.state,
  };
  const nameParts = splitName(talentName);
  const firstNameValue = record?.first_name ?? nameParts.first;
  const lastNameValue = record?.last_name ?? nameParts.last;
  const emailValue = record?.email1 ?? entry.email ?? null;
  const phoneValue = record?.phone_cell ?? entry.phone ?? null;
  const workAuthValue =
    record?.work_authorization ?? (entry.work_auth as WorkAuthorization | null) ?? null;
  const desiredValue = record?.desired_pay ?? entry.desired_rate ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentBucket = funnelBucket(entry.status);
  const currentIdx = BUCKET_INDEX[currentBucket] ?? 0;
  const legal = new Set<PipelineStatus>(legalNextStates(entry.status));

  const move = async (bucket: FunnelBucketKey): Promise<void> => {
    const target = BUCKET_TARGET[bucket];
    if (target === entry.status || !legal.has(target)) return;
    setBusy(bucket);
    setErr(null);
    try {
      const updated = await transitionPipeline(entry.id, {
        to_status: target,
        expected_version: entry.version,
      });
      onTransitioned(updated);
    } catch {
      setErr('Could not move the talent — the backend rejected this transition.');
    } finally {
      setBusy(null);
    }
  };

  const name =
    talentName ??
    (record ? `${record.first_name} ${record.last_name}`.trim() : '—');

  return (
    <>
      <div className="rc-cdp__backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        className="rc-cdp"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} — talent detail`}
      >
        <header className="rc-cdp__hd">
          <Avatar name={name} size="md" />
          <div className="rc-cdp__id">
            <div className="rc-cdp__name">
              {name}
              {isNew ? <span className="rc-cdp__new">NEW</span> : null}
            </div>
            <div className="rc-cdp__role">
              {reqTitle} · {reqCode}
            </div>
          </div>
          {onToggleHot !== undefined ? (
            <HotToggle
              hot={isHot}
              label={name}
              disabled={!canEditHot}
              onToggle={(next) => onToggleHot(next)}
            />
          ) : null}
          <button type="button" className="rc-cdp__x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="rc-cdp__body">
          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Workflow status</div>
            <ol className="rc-cdp__steps">
              {FUNNEL_BUCKETS.map((b, i) => {
                const done = i < currentIdx;
                const current = i === currentIdx;
                const target = BUCKET_TARGET[b.key];
                const clickable = target !== entry.status && legal.has(target);
                return (
                  <li key={b.key}>
                    <button
                      type="button"
                      disabled={!clickable || busy !== null}
                      onClick={() => void move(b.key)}
                      aria-current={current ? 'step' : undefined}
                      className={`rc-cdp__step${current ? ' rc-cdp__step--current' : ''}${
                        done ? ' rc-cdp__step--done' : ''
                      }${clickable ? ' rc-cdp__step--click' : ''}`}
                    >
                      <span className="rc-cdp__dot" aria-hidden="true">
                        {done ? '✓' : ''}
                      </span>
                      <span className="rc-cdp__steplabel">{b.label}</span>
                      {current ? <span className="rc-cdp__chip">CURRENT</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            {err ? <p className="rc-cdp__err">{err}</p> : null}
            <p className="rc-cdp__note">Every change is logged to the audit trail.</p>
          </section>

          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Offer decision</div>
            <OfferPanelContainer
              requisitionId={entry.requisition_id}
              talentRecordId={entry.talent_record_id}
              scopes={scopes}
            />
          </section>

          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Talent details</div>
            {canEditTalent ? (
              // EDITABLE — sourced from the RAW record; each field PATCHes its
              // own talent-record column. do_not_contact governs contact-detail
              // display only, not edit capability (backend authoritative).
              <div className="rc-cdp__grid">
                {/* Values fall back to `entry.*` enrichment when the raw record
                    is null (getTalent 404) so an existing value always shows. */}
                <InlineEditField
                  label="First name"
                  value={firstNameValue}
                  canEdit
                  testId="tf-first_name"
                  onSave={(v) => patchColumn({ first_name: v ?? '' }, { first_name: v ?? '' })}
                />
                <InlineEditField
                  label="Last name"
                  value={lastNameValue}
                  canEdit
                  testId="tf-last_name"
                  onSave={(v) => patchColumn({ last_name: v ?? '' }, { last_name: v ?? '' })}
                />
                <InlineEditField
                  label="Email"
                  value={emailValue}
                  canEdit
                  testId="tf-email1"
                  onSave={(v) => patchColumn({ email1: v }, { email1: v }, { email: v })}
                />
                <InlineEditField
                  label="Phone"
                  value={phoneValue}
                  canEdit
                  testId="tf-phone_cell"
                  onSave={(v) => patchColumn({ phone_cell: v }, { phone_cell: v }, { phone: v })}
                />
                {/* Location = city + state (edit both; read-only shows "City, ST").
                    The enrichment location is recomposed from the pair so the
                    extender's "City, ST" cell reflects either edit. */}
                <InlineEditField
                  label="City"
                  value={loc.city}
                  canEdit
                  testId="tf-city"
                  onSave={(v) =>
                    patchColumn({ city: v }, { city: v }, { location: composeLocation(v, loc.state) })
                  }
                />
                <InlineEditField
                  label="State"
                  value={loc.state}
                  canEdit
                  testId="tf-state"
                  onSave={(v) =>
                    patchColumn({ state: v }, { state: v }, { location: composeLocation(loc.city, v) })
                  }
                />
                <InlineSelectField
                  label="Work authorization"
                  value={workAuthValue}
                  canEdit
                  allowEmpty
                  emptyLabel="—"
                  options={WORK_AUTH_OPTIONS}
                  testId="tf-work_authorization"
                  onSave={(v) =>
                    patchColumn(
                      { work_authorization: v as WorkAuthorization | null },
                      { work_authorization: v as WorkAuthorization | null },
                      { work_auth: v },
                    )
                  }
                />
              </div>
            ) : (
              // READ-ONLY — the requisition-expander enrichment (entry.*). authz
              // (talent:read) gates EXISTENCE (absent key); do_not_contact
              // suppresses email/phone ONLY (→ null). absent OR suppressed both
              // collapse to the em-dash (masked-by-absence).
              <div className="rc-cdp__grid">
                <Field label="First name" value={record?.first_name ?? '—'} />
                <Field label="Last name" value={record?.last_name ?? '—'} />
                <Field label="Email" value={enrichmentValue(entry.email)} />
                <Field label="Phone" value={enrichmentValue(entry.phone)} />
                <Field label="Location" value={enrichmentValue(entry.location)} />
                <Field label="Work authorization" value={enrichmentValue(entry.work_auth)} />
              </div>
            )}
          </section>

          <section className="rc-cdp__sec">
            <div className="rc-cdp__seclabel">Rates — this position</div>
            <div className="rc-cdp__rates">
              <div className="rc-cdp__rate">
                <div className="rc-cdp__ratelabel">Desired rate</div>
                {/* desired_pay — editable under talent:edit; else the enriched
                    read-only value. */}
                {canEditTalent ? (
                  <InlineEditField
                    label="Desired rate"
                    value={desiredValue}
                    canEdit
                    testId="tf-desired_pay"
                    onSave={(v) => patchColumn({ desired_pay: v }, { desired_pay: v }, { desired_rate: v })}
                  />
                ) : (
                  <div className="rc-cdp__rateval mono">
                    {enrichmentValue(entry.desired_rate)}
                  </div>
                )}
              </div>
              <div className="rc-cdp__rate rc-cdp__rate--agreed">
                <div className="rc-cdp__ratelabel">Agreed pay rate</div>
                {/* NOT editable — a placement/assignment value, not a
                    talent-record column. Never faked. */}
                <div className="rc-cdp__rateval mono">—</div>
              </div>
            </div>
          </section>

          <div className="rc-cdp__next">
            <span className="rc-cdp__nextl">Next step</span>
            {PIPELINE_NEXT_ACTION[entry.status]}
          </div>
        </div>

        <footer className="rc-cdp__ft">
          <Link
            to={`/talent/${entry.talent_record_id}`}
            className="rc-cdp__btn rc-cdp__btn--sec"
          >
            Open full profile
          </Link>
          <Link
            to={`/talent/${entry.talent_record_id}`}
            className="rc-cdp__btn rc-cdp__btn--pri"
          >
            Log activity
          </Link>
        </footer>
      </aside>
    </>
  );
}

// Enrichment renderer: present-and-non-null → the value; absent (no talent:read)
// OR suppressed (do_not_contact → null) → the em-dash. absent ≠ null but both
// present the same non-leaking indicator (masked-by-absence).
function enrichmentValue(v: string | null | undefined): string {
  return v != null && v !== '' ? v : '—';
}

// Parse the enrichment "City, ST" on the LAST comma → city + state (no comma ⇒
// city = whole, state = null). Empty in → both null.
function parseLocation(location: string | null): {
  readonly city: string | null;
  readonly state: string | null;
} {
  if (location === null || location.trim() === '') return { city: null, state: null };
  const idx = location.lastIndexOf(',');
  if (idx < 0) return { city: location.trim() || null, state: null };
  return {
    city: location.slice(0, idx).trim() || null,
    state: location.slice(idx + 1).trim() || null,
  };
}

// Recompose the enrichment "City, ST" from a (city, state) pair; empty pair ⇒ null.
function composeLocation(city: string | null, state: string | null): string | null {
  const joined = [city, state].filter((s) => s !== null && s !== '').join(', ');
  return joined === '' ? null : joined;
}

// Split the display talentName into first + rest on the first space (fallback
// when the raw record is null).
function splitName(talentName: string | undefined): {
  readonly first: string | null;
  readonly last: string | null;
} {
  if (talentName === undefined || talentName.trim() === '') {
    return { first: null, last: null };
  }
  const trimmed = talentName.trim();
  const idx = trimmed.indexOf(' ');
  if (idx < 0) return { first: trimmed, last: null };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1).trim() || null };
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rc-cdp__field">
      <div className="rc-cdp__fieldl">{label}</div>
      <div className="rc-cdp__fieldv">{value}</div>
    </div>
  );
}
