import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, HotToggle } from '../ui';
import { InlineEditField, InlineSelectField } from '../components/InlineEditField';
import { transitionPipeline } from '../pipeline/pipeline-api';
import {
  getTalentJourney,
  type TalentRequisitionJourney,
} from '../pipeline/talent-journey-api';
import { type PipelineStatus, type PipelineView } from '../pipeline/types';
import { OfferPanelContainer } from '../offers/OfferPanelContainer';
import { CallButton } from '../communications/CallButton';
import { VoiceEvidenceSummary } from '../communications/VoiceEvidenceSummary';
import { getVoiceEngagementEvidence } from '../communications/communications-api';
import type { VoiceEngagementEvidence } from '../communications/types';
import { EngagementReadinessSummary } from '../engagement/EngagementReadinessSummary';
import { getTalent, updateTalent } from '../talent/talent-api';
import type { TalentRecordView, UpdateTalentRecordRequest } from '../talent/types';
import {
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
  type WorkAuthorization,
} from '../talent/stated-fields';

import { TalentJourneySection } from './TalentJourneySection';

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
// expanded row. S3 — the former cosmetic Pipeline-only workflow stepper is
// SUPERSEDED by the backend-owned Unified Talent Journey (TalentJourneySection,
// GET /v1/pipelines/:id/journey). Pipeline no longer presents downstream stage
// truth here; each stage is owner-attributed by the server. Offer creation stays
// governed by the delivered Offer API + ClientSelection SELECTED gate (the drawer
// surfaces the Offer decision panel only when the journey returns an offer action).

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
  // S3 — backend-owned Unified Talent Journey for this pipeline episode. The
  // single source of cross-owner stage truth (no FE re-derivation).
  const [journey, setJourney] = useState<TalentRequisitionJourney | null>(null);
  const [journeyErr, setJourneyErr] = useState<string | null>(null);
  // Recruiting-lane advance (governed Pipeline transition). CAS version is echoed
  // from the last successful transition so repeated advances stay conflict-safe.
  const [version, setVersion] = useState(entry.version);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineErr, setPipelineErr] = useState<string | null>(null);
  const canAdvancePipeline = scopes.includes('pipeline:change-status');
  // COMM-C2A — derived voice engagement evidence for this Talent × Requisition,
  // loaded when the drawer opens (R5 — no first-paint/list fan-out).
  const canCall = scopes.includes('communication:voice:call');
  const [voiceEvidence, setVoiceEvidence] = useState<VoiceEngagementEvidence | null>(null);

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

  // S3 — fetch the owner-attributed journey for THIS pipeline episode. A
  // non-visible/cross-tenant episode is concealed as 404 by the server; we keep
  // the drawer usable (details/rates still render) and surface a neutral note.
  useEffect(() => {
    let cancelled = false;
    void getTalentJourney(entry.id)
      .then((j) => {
        if (!cancelled) setJourney(j);
      })
      .catch(() => {
        if (!cancelled) setJourneyErr('Journey is unavailable for this talent.');
      });
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  // Re-read the owner-attributed journey after a governed action so the rail and
  // current lane reflect the new authoritative state (no optimistic FE guess).
  const refetchJourney = (): void => {
    void getTalentJourney(entry.id)
      .then((j) => setJourney(j))
      .catch(() => {
        /* keep the last-known journey; the action already succeeded */
      });
  };

  // COMM-C2A — load the derived voice evidence when the drawer opens; refetch
  // after a call/disposition (a first attempt may also have advanced the pipeline,
  // so the journey is re-read too).
  const refetchVoiceEvidence = (): void => {
    void getVoiceEngagementEvidence(entry.talent_record_id, entry.requisition_id)
      .then((e) => setVoiceEvidence(e))
      .catch(() => {
        /* neutral — the drawer stays usable without the evidence summary */
      });
  };
  useEffect(() => {
    let cancelled = false;
    void getVoiceEngagementEvidence(entry.talent_record_id, entry.requisition_id)
      .then((e) => {
        if (!cancelled) setVoiceEvidence(e);
      })
      .catch(() => {
        /* neutral */
      });
    return () => {
      cancelled = true;
    };
  }, [entry.talent_record_id, entry.requisition_id]);

  const handleVoiceCompleted = (): void => {
    refetchVoiceEvidence();
    refetchJourney();
  };

  // Recruiting-lane advance — a REAL governed Pipeline transition (CAS-guarded).
  // Legality is the backend's; a rejected move surfaces a controlled message and
  // never advances the UI. On success we re-read the journey (the authority).
  const handleRecruitingAdvance = (toStatus: string): void => {
    setPipelineBusy(true);
    setPipelineErr(null);
    void transitionPipeline(entry.id, {
      to_status: toStatus as PipelineStatus,
      expected_version: version,
    })
      .then((updated) => {
        setVersion(updated.version);
        onTransitioned(updated);
        refetchJourney();
      })
      .catch(() => {
        setPipelineErr('Could not advance — the backend rejected this action.');
      })
      .finally(() => setPipelineBusy(false));
  };

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

  // Offer is realised ONLY from REAL domain truth: ClientSelection === SELECTED
  // (the delivered offer-create precondition) or an offer row already exists. It
  // is NEVER inferred from actions[] or the presence of a pipeline/talent row —
  // that was the workflow-sequencing defect (premature "Make offer" at no_contact).
  const selectionState =
    (journey?.sub_states['selection_state'] as string | null | undefined) ?? null;
  const hasOfferRow = journey?.stages.some((s) => s.owner === 'offer') ?? false;
  const offerRelevant = selectionState === 'SELECTED' || hasOfferRow;

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
          {journey !== null ? (
            <TalentJourneySection
              journey={journey}
              talentRecordId={entry.talent_record_id}
              requisitionId={entry.requisition_id}
              canAdvancePipeline={canAdvancePipeline}
              onRecruitingAdvance={handleRecruitingAdvance}
              pipelineBusy={pipelineBusy}
              error={pipelineErr}
            />
          ) : (
            <section className="rc-cdp__sec">
              <div className="rc-cdp__seclabel">Talent journey</div>
              <p className="rc-cdp__note">{journeyErr ?? 'Loading journey…'}</p>
            </section>
          )}

          {/* COMM-C2A — Voice engagement (Recruiting presentation only, R9). A
              truthful evidence summary + the governed Call control for this
              Talent × Requisition. Placing a call records durable evidence and can
              drive the governed no_contact→contacted transition server-side; it
              NEVER implies qualification or client-submittal eligibility (R8). */}
          <section className="rc-cdp__sec" data-testid="voice-engagement">
            <div className="rc-cdp__seclabel">Voice engagement</div>
            <VoiceEvidenceSummary evidence={voiceEvidence} />
            {record !== null ? (
              <CallButton
                talent={record}
                session={null}
                canCall={canCall}
                regarding={{ requisition_id: entry.requisition_id, pipeline_id: entry.id }}
                onCompleted={handleVoiceCompleted}
              />
            ) : null}
          </section>

          {/* COMM-C3 — Submittal readiness (engagement gate). Provider-neutral
              per-requirement status; loaded on drawer open (no list fan-out, R18).
              It states only whether engagement requirements are met — NEVER that
              the Talent is Qualified (R19). The backend gate is authoritative. */}
          <section className="rc-cdp__sec" data-testid="submittal-readiness">
            <div className="rc-cdp__seclabel">Submittal readiness</div>
            <EngagementReadinessSummary
              talentId={entry.talent_record_id}
              requisitionId={entry.requisition_id}
            />
          </section>

          {/* Offer decision — surfaced ONLY when the journey permits an offer
              (server returns an offer action once ClientSelection is SELECTED) or
              one already exists. The delivered Offer API + SELECTED gate remain
              authoritative; there is no FE bypass and Qualified never shows it. */}
          {offerRelevant ? (
            <section className="rc-cdp__sec">
              <div className="rc-cdp__seclabel">Offer decision</div>
              <OfferPanelContainer
                requisitionId={entry.requisition_id}
                talentRecordId={entry.talent_record_id}
                scopes={scopes}
              />
            </section>
          ) : null}

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
