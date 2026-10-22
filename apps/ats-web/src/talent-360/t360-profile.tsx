import { Input, Select, TextArea } from '@aramo/fe-foundation';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { updateErrorMessage } from '../talent/error-messages';
import { buildPatchBody, stateFromTalent, type IntakeState } from '../talent/intake-fields';
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TYPE_VALUES,
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
  PAY_FIELD_KEYS,
  withCurrency,
} from '../talent/stated-fields';
import { getTalentWorkHistory, updateTalent } from '../talent/talent-api';
import { EducationEditor } from '../talent/EducationEditor';
import type { ProfileHydrationItem } from '../talent/profile-hydration';
import type { TalentRecordView, WorkAuthorizationStateView, WorkHistoryDraft, WorkHistoryView } from '../talent/types';
import { Button } from '../ui';

import { labelize, type T360Section } from './t360-model';
import { workHistorySourceLabel } from './t360-vocab';
import type { Talent360View as Model } from './talent-360-types';

// Talent 360 → Profile (§8A): the talent record in Edit talent's section order,
// read-only by default and EDITABLE IN PLACE one card at a time (§8A.7).
//
// Sources: the full record (getTalent — same read + scope gate as Edit talent)
// and declared work history (GET /talent-records/:id/work-history), loaded lazily
// by the page; the Talent 360 read is the fallback on 404/403 (read-only then).
// Each field is shown from exactly one source.
//
// Inline edit reuses Edit talent's contract verbatim: the existing PATCH
// /v1/talent-records/:id (talent:edit) with a body built by Edit talent's own
// buildPatchBody — a card changes only ITS keys in a copy of the loaded record,
// so the body carries only that card's changed fields (identity anchors email1 /
// phone_cell are never sent; '' clears to null; work history is replace-set).

export interface ProfileData {
  /** 'fallback' = the full record could not be read; only the Talent 360 read is used. */
  readonly status: 'loading' | 'ready' | 'fallback';
  readonly record: TalentRecordView | null;
  readonly workHistory: readonly WorkHistoryView[] | null;
  /** Governed work-authorization state (GET /talent-records/:id/work-authorization). */
  readonly workAuth: WorkAuthorizationStateView | null;
  /** Per-field provenance (GET /talent-records/:id/profile-hydration), keyed by field. */
  readonly hydration: ReadonlyMap<string, ProfileHydrationItem> | null;
}

// A3 — the per-field source line from the existing provenance read: where the
// current value came from, and whether a resume-proposed change awaits review.
// It carries no actor/date — "Edited by … · date" needs change attribution (C4).
export function provenanceLine(item: ProfileHydrationItem | undefined): string | undefined {
  if (item === undefined) return undefined;
  if (item.resolution_status === 'PENDING_REVIEW') return 'Pending review · the resume proposes a different value';
  switch (item.source_type) {
    case 'RESUME':
      return 'From resume';
    case 'MANUAL':
      return 'Entered manually';
    case 'IMPORT':
      return 'Imported';
    case 'RECONCILED':
      return 'Reconciled from evidence';
    default:
      return undefined;
  }
}

type CardKey = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09';

const CARD_TITLES: Record<CardKey, string> = {
  '01': 'Identity & contact',
  '02': 'Location',
  '03': 'Professional',
  '04': 'Work authorization',
  '05': 'Availability & preferences',
  '06': 'Skills',
  '07': 'Source & ownership',
  '08': 'Recruiter notes',
  '09': 'Work history',
};

const HIDDEN_CONTACT = 'Hidden · do not contact';
const isPayKey = (k: string): boolean => (PAY_FIELD_KEYS as readonly string[]).includes(k);

interface Row {
  readonly l: string;
  readonly v: string | null;
  readonly src?: string;
  readonly href?: string;
  readonly mono?: boolean;
  readonly pre?: boolean;
  /** Record keys behind this row — drives "Updated just now by you". */
  readonly keys?: readonly string[];
}

function present(v: string | null | undefined): string | null {
  return v === null || v === undefined || v.trim() === '' ? null : v;
}
function label<T extends string>(map: Record<T, string>, v: string | null): string | null {
  if (v === null) return null;
  return (map as Record<string, string>)[v] ?? labelize(v);
}
function websiteHref(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
function dateLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function yearOf(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  return /^(\d{4})/.exec(iso)?.[1] ?? null;
}
function span(start: string | null | undefined, end: string | null | undefined): string {
  const s = yearOf(start);
  const e = yearOf(end);
  if (s === null && e === null) return '';
  return `${s ?? ''} – ${e ?? 'Present'}`;
}
function splitSkills(v: string): string[] {
  return v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
function draftFromView(v: WorkHistoryView): WorkHistoryDraft {
  return {
    employer_name: v.employer_name,
    role_title: v.role_title,
    ...(v.start_date !== null ? { start_date: v.start_date } : {}),
    ...(v.end_date !== null ? { end_date: v.end_date } : {}),
    ...(v.employment_type !== null ? { employment_type: v.employment_type } : {}),
    ...(v.description !== null ? { description: v.description } : {}),
  };
}

// ── read rendering ────────────────────────────────────────────────────────────

function Value({ r }: { r: Row }): JSX.Element {
  if (r.v === null) return <span className="t360-pv t360-pv--empty">—</span>;
  if (r.href !== undefined) {
    return (
      <a className="t360-pv t360-pv--link" href={r.href} target="_blank" rel="noreferrer">
        {r.v}
      </a>
    );
  }
  return <span className={`t360-pv${r.mono === true ? ' t360-mono' : ''}${r.pre === true ? ' t360-pv--pre' : ''}`}>{r.v}</span>;
}

function ReadRows({ rows, updated, hydration }: { rows: readonly Row[]; updated: ReadonlySet<string>; hydration: ReadonlyMap<string, ProfileHydrationItem> | null }): JSX.Element {
  return (
    <>
      {rows.map((r) => {
        const fresh = (r.keys ?? []).some((k) => updated.has(k));
        // Precedence: just saved › a fixed/returned qualifier › field provenance (A3).
        const prov = r.v !== null && r.keys !== undefined && r.keys.length > 0 ? provenanceLine(hydration?.get(r.keys[0] ?? '')) : undefined;
        const src = fresh ? 'Updated just now by you' : (r.src ?? prov);
        return (
          <div key={r.l} className="t360-prow2">
            <span className="t360-prow2__l">{r.l}</span>
            <span className="t360-min0">
              <Value r={r} />
              {src !== undefined ? <span className="t360-prow2__s">{src}</span> : null}
            </span>
          </div>
        );
      })}
    </>
  );
}

// ── edit controls ─────────────────────────────────────────────────────────────

function FieldRow({ l, req, err, children }: { l: string; req?: boolean; err?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="t360-prow2 t360-prow2--edit">
      <span className="t360-prow2__el">
        {l}
        {req === true ? <span className="t360-req"> *</span> : null}
      </span>
      <span className="t360-min0">
        {children}
        {err !== undefined ? <span className="t360-ferr">{err}</span> : null}
      </span>
    </div>
  );
}

function Locked({ value, note }: { value: string | null; note: string }): JSX.Element {
  return (
    <span className="t360-locked">
      <span className="t360-locked__v">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        {value ?? '—'}
      </span>
      <span className="t360-prow2__s">{note}</span>
    </span>
  );
}

function YesNo({ value, onChange, ariaLabel }: { value: boolean; onChange: (v: boolean) => void; ariaLabel: string }): JSX.Element {
  return (
    <span className="t360-seg" role="radiogroup" aria-label={ariaLabel}>
      {[true, false].map((v) => (
        <Button
          unstyled
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`t360-seg__opt${value === v ? ' t360-seg__opt--on' : ''}`}
          onClick={() => onChange(v)}
        >
          {v ? 'Yes' : 'No'}
        </Button>
      ))}
    </span>
  );
}

// ── the section ───────────────────────────────────────────────────────────────

export interface ProfileSectionProps {
  readonly model: Model;
  readonly data: ProfileData;
  readonly talentId: string;
  /** talent:edit — the Edit talent audience (inline edit + current pay). */
  readonly canEdit: boolean;
  readonly canSeePay: boolean;
  readonly go: (s: T360Section) => void;
  readonly onRecordSaved: (rec: TalentRecordView) => void;
  readonly onWorkHistorySaved: (list: readonly WorkHistoryView[]) => void;
  readonly notify: (msg: string) => void;
}

export function ProfileSection({ model, data, talentId, canEdit, canSeePay, go, onRecordSaved, onWorkHistorySaved, notify }: ProfileSectionProps): JSX.Element {
  const h = model.header;
  const rec = data.record;
  const editable = canEdit && data.status === 'ready' && rec !== null;
  const id = model.identity;

  const [editing, setEditing] = useState<CardKey | null>(null);
  const [draft, setDraft] = useState<IntakeState | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState('');
  const [wh, setWh] = useState<WorkHistoryDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<ReadonlySet<string>>(new Set());
  // ATS-QA-1 I-4 — current education; seeded from the Talent 360 read and replaced
  // by each education write's response.
  const [education, setEducation] = useState(model.profile.education ?? []);
  useEffect(() => setEducation(model.profile.education ?? []), [model.profile.education]);

  const startEdit = (k: CardKey): void => {
    if (rec === null) return;
    setDraft(stateFromTalent(rec));
    setSkills(splitSkills(rec.key_skills ?? ''));
    setSkillInput('');
    setWh((data.workHistory ?? []).map(draftFromView));
    setErrors({});
    setFormError(null);
    setEditing(k);
  };
  const cancel = (): void => {
    setEditing(null);
    setDraft(null);
    setErrors({});
    setFormError(null);
  };
  const set = (key: keyof IntakeState, value: string | boolean): void => setDraft((d) => (d === null ? d : { ...d, [key]: value }));

  const validate = (k: CardKey): Record<string, string> => {
    const e: Record<string, string> = {};
    if (draft === null) return e;
    if (k === '01') {
      if (draft.first_name.trim() === '') e['first_name'] = 'Required';
      if (draft.last_name.trim() === '') e['last_name'] = 'Required';
    }
    if (k === '02') {
      if (draft.city.trim() === '') e['city'] = 'Required';
      if (draft.state.trim() === '') e['state'] = 'Required';
    }
    if (k === '09') {
      wh.forEach((w, i) => {
        if (w.role_title.trim() === '') e[`wh-${i}-role`] = 'Required';
        if (w.employer_name.trim() === '') e[`wh-${i}-org`] = 'Required';
      });
    }
    return e;
  };

  const save = async (k: CardKey): Promise<void> => {
    if (rec === null || draft === null) return;
    const v = validate(k);
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    const state: IntakeState = k === '06' ? { ...draft, key_skills: skills.join(', ') } : draft;
    const body = buildPatchBody(state, rec, k === '09' ? wh : undefined) as unknown as Record<string, unknown>;
    const changed = Object.keys(body);
    const title = CARD_TITLES[k];
    if (changed.length === 0) {
      cancel();
      notify(`${title} saved · no changes`);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const updatedRec = await updateTalent(rec.id, body);
      onRecordSaved(updatedRec);
      if (k === '09') {
        const fresh = await getTalentWorkHistory(rec.id).catch(() => null);
        if (fresh !== null) onWorkHistorySaved(fresh.work_history);
      }
      setUpdated(new Set(changed));
      cancel();
      notify(`${title} saved · ${changed.length} field${changed.length === 1 ? '' : 's'} updated`);
    } catch (err) {
      // Keep the card open with what was entered; surface the controlled message.
      setFormError(updateErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // ── read rows (from exactly one source each) ──
  const cityState =
    rec !== null
      ? present([[rec.city, rec.state].filter((x) => present(x) !== null).join(', '), rec.zip].filter((x) => present(x) !== null).join(' '))
      : present(h.location);
  const owners = [...new Set((model.opportunities?.active ?? []).map((o) => o.owner_label).filter((x): x is string => present(x) !== null))];
  const website = present(rec?.web_site);
  const wa = data.workAuth?.current ?? null;
  // INC-2 Correction A — a do-not-contact talent's contact channels are suppressed
  // on the composed read; the full record (GET /talent-records/:id) is not, so the
  // Profile must apply the same rule rather than show what the header hides.
  const contactHidden = h.contactability.summary === 'do_not_contact';
  const hiddenRow = (l: string): Row => ({ l, v: null, src: HIDDEN_CONTACT });

  const readRows: Record<Exclude<CardKey, '06' | '09'>, Row[]> = {
    '01': [
      { l: 'Name', v: rec !== null ? `${rec.first_name} ${rec.last_name}`.trim() : h.display_name, keys: ['first_name', 'last_name'] },
      { l: 'Title', v: present(rec !== null ? rec.title : h.title), keys: ['title'] },
      ...(contactHidden
        ? [hiddenRow('Email'), hiddenRow('Phone')]
        : [
            { l: 'Primary email', v: present(rec !== null ? rec.email1 : h.email), ...(id?.primary_email_confirmed === true ? { src: 'Confirmed' } : {}) },
            ...(present(rec?.email2) !== null ? [{ l: 'Secondary email', v: rec?.email2 ?? null, keys: ['email2'] }] : []),
            { l: 'Mobile', v: present(rec !== null ? rec.phone_cell : h.phone), ...(id?.mobile_confirmed === true ? { src: 'Confirmed by SMS code' } : {}) },
            {
              l: 'Home / work phone',
              v: present([rec?.phone_home, rec?.phone_work].filter((x): x is string => present(x) !== null).join(' · ')),
              keys: ['phone_home', 'phone_work'],
            },
          ]),
      { l: 'Best time to call', v: present(rec?.best_time_to_call), keys: ['best_time_to_call'] },
      website !== null ? { l: 'Website', v: website, href: websiteHref(website), keys: ['web_site'] } : { l: 'Website', v: null, keys: ['web_site'] },
    ],
    '02': [
      { l: 'Address', v: present([rec?.address, rec?.address2].filter((x): x is string => present(x) !== null).join(', ')), keys: ['address', 'address2'] },
      { l: 'City / state', v: cityState, keys: ['city', 'state', 'zip'] },
      { l: 'Country', v: present(rec?.country), keys: ['country'] },
      { l: 'Can relocate', v: rec === null ? null : rec.can_relocate ? 'Yes' : 'No', keys: ['can_relocate'] },
    ],
    '03': [
      { l: 'Current employer', v: present(rec?.current_employer), keys: ['current_employer'] },
      { l: 'Experience', v: present(h.experience_summary) },
    ],
    '04': [
      {
        l: 'Status',
        v: label(WORK_AUTHORIZATION_LABELS, rec !== null ? rec.work_authorization : h.work_authorization),
        ...(wa !== null ? { src: `Declared · ${dateLabel(wa.asserted_at) ?? ''}` } : {}),
        keys: ['work_authorization'],
      },
      ...(wa !== null && present(wa.visa_type) !== null ? [{ l: 'Visa type', v: wa.visa_type }] : []),
      // TI-1G: requires_sponsorship stays at its default until a surface collects it,
      // and none does yet — never present the default as a fact.
      { l: 'Sponsorship', v: null, src: 'Not collected yet' },
      ...(wa !== null && wa.expires_at !== null ? [{ l: 'Expires', v: dateLabel(wa.expires_at) }] : []),
      { l: 'Document', v: null, src: 'Collected at pre-start' },
    ],
    '05': [
      { l: 'Availability', v: label(AVAILABILITY_LABELS, rec !== null ? rec.availability_status : h.availability.status), keys: ['availability_status'] },
      { l: 'Available from', v: dateLabel(rec?.date_available ?? null), keys: ['date_available'] },
      { l: 'Engagement', v: label(ENGAGEMENT_LABELS, rec !== null ? rec.engagement_type : h.engagement_type), keys: ['engagement_type'] },
      { l: 'Desired rate', v: withCurrency(present(rec !== null ? rec.desired_pay : h.desired_compensation)), mono: true, keys: ['desired_pay'] },
      ...(canSeePay ? [{ l: 'Current pay', v: withCurrency(present(rec?.current_pay)), mono: true, src: 'Visible to recruiters only', keys: ['current_pay'] }] : []),
      { l: 'Hot talent', v: rec === null ? null : rec.is_hot ? 'Yes' : 'No', keys: ['is_hot'] },
    ],
    '07': [
      { l: 'Source', v: present(rec !== null ? rec.source : model.relationship.ownership.source), keys: ['source'] },
      { l: 'Record added by', v: present(model.relationship.ownership.owner_provenance?.name) },
      { l: 'Currently working with', v: owners.length > 0 ? owners.join(' · ') : null, src: 'Per requisition — no talent-level owner' },
    ],
    '08': [{ l: 'On the record', v: present(rec?.notes), pre: true, src: 'Separate from activity Notes', keys: ['notes'] }],
  };

  // ── edit fields per card ──
  const d = draft;
  const text = (key: keyof IntakeState, l: string, opts: { req?: boolean; type?: string; mono?: boolean } = {}): JSX.Element | null =>
    d === null ? null : (
      <FieldRow key={key} l={l} req={opts.req} err={errors[key]}>
        <Input
          unstyled
          className={`t360-ctl${errors[key] !== undefined ? ' t360-ctl--err' : ''}`}
          type={opts.type ?? 'text'}
          aria-label={l}
          value={d[key] as string}
          onChange={(e) => set(key, e.target.value)}
          {...(isPayKey(key) ? { placeholder: '$70/hr', onBlur: () => set(key, withCurrency(d[key] as string)) } : {})}
        />
      </FieldRow>
    );
  const select = <T extends string>(key: 'availability_status' | 'engagement_type' | 'work_authorization', l: string, values: readonly T[], labels: Record<T, string>): JSX.Element | null =>
    d === null ? null : (
      <FieldRow key={key} l={l}>
        <Select unstyled className="t360-ctl" aria-label={l} value={d[key]} onChange={(e) => set(key, e.target.value)}>
          <option value="">Not stated</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {labels[v]}
            </option>
          ))}
        </Select>
      </FieldRow>
    );
  const yesNo = (key: 'can_relocate' | 'is_hot', l: string): JSX.Element | null =>
    d === null ? null : (
      <FieldRow key={key} l={l}>
        <YesNo value={d[key]} ariaLabel={l} onChange={(v) => set(key, v)} />
      </FieldRow>
    );

  const editFields = (k: CardKey): ReactNode => {
    if (d === null || rec === null) return null;
    switch (k) {
      case '01':
        return (
          <>
            {text('first_name', 'First name', { req: true })}
            {text('last_name', 'Last name', { req: true })}
            {text('title', 'Title')}
            {contactHidden ? (
              <>
                <FieldRow l="Email">
                  <Locked value={null} note={HIDDEN_CONTACT} />
                </FieldRow>
                <FieldRow l="Phone">
                  <Locked value={null} note={HIDDEN_CONTACT} />
                </FieldRow>
              </>
            ) : (
              <>
                <FieldRow l="Primary email">
                  <Locked value={present(rec.email1)} note="Identity anchor · change through identity review" />
                </FieldRow>
                {text('email2', 'Secondary email', { type: 'email' })}
                <FieldRow l="Mobile">
                  <Locked value={present(rec.phone_cell)} note="Identity anchor · change through identity review" />
                </FieldRow>
                <FieldRow l="Home / work phone">
                  <span className="t360-ctlpair">
                    <Input unstyled className="t360-ctl" aria-label="Home phone" placeholder="Home" value={d.phone_home} onChange={(e) => set('phone_home', e.target.value)} />
                    <Input unstyled className="t360-ctl" aria-label="Work phone" placeholder="Work" value={d.phone_work} onChange={(e) => set('phone_work', e.target.value)} />
                  </span>
                </FieldRow>
              </>
            )}
            {text('best_time_to_call', 'Best time to call')}
            {text('web_site', 'Website')}
          </>
        );
      case '02':
        return (
          <>
            {text('address', 'Street')}
            {text('address2', 'Line 2')}
            {text('city', 'City', { req: true })}
            {text('state', 'State', { req: true })}
            {text('zip', 'Postal code')}
            {text('country', 'Country')}
            {yesNo('can_relocate', 'Can relocate')}
          </>
        );
      case '03':
        return <>{text('current_employer', 'Current employer')}</>;
      case '04':
        return (
          <>
            {select('work_authorization', 'Status', WORK_AUTHORIZATION_VALUES, WORK_AUTHORIZATION_LABELS)}
            <FieldRow l="Sponsorship">
              <Locked value={null} note="Not collected yet · needs the governed work-authorization update" />
            </FieldRow>
            <FieldRow l="Document">
              <Locked value={null} note="Collected at pre-start, not here" />
            </FieldRow>
          </>
        );
      case '05':
        return (
          <>
            {select('availability_status', 'Availability', AVAILABILITY_STATUS_VALUES, AVAILABILITY_LABELS)}
            {text('date_available', 'Available from', { type: 'date' })}
            {select('engagement_type', 'Engagement', ENGAGEMENT_TYPE_VALUES, ENGAGEMENT_LABELS)}
            {text('desired_pay', 'Desired rate')}
            {canSeePay ? text('current_pay', 'Current pay') : null}
            {yesNo('is_hot', 'Hot talent')}
          </>
        );
      case '07':
        return (
          <>
            {text('source', 'Source')}
            <FieldRow l="Record added by">
              <Locked value={present(model.relationship.ownership.owner_provenance?.name)} note="Provenance · can’t be changed" />
            </FieldRow>
          </>
        );
      case '08':
        return (
          <FieldRow l="On the record">
            <TextArea unstyled className="t360-ctl t360-ctl--area" rows={4} aria-label="On the record" value={d.notes} onChange={(e) => set('notes', e.target.value)} />
          </FieldRow>
        );
      default:
        return null;
    }
  };

  // ── card chrome ──
  const editButton = (k: CardKey): JSX.Element | null => {
    if (!editable) return null;
    if (editing === k) {
      return (
        <span className="t360-cardact">
          <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-btn--xs" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
          <Button unstyled type="button" className="t360-btn t360-btn--primary t360-btn--xs t360-btn--save" disabled={saving} onClick={() => void save(k)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </span>
      );
    }
    const blocked = editing !== null;
    return (
      <Button
        unstyled
        type="button"
        className={`t360-pblock__edit${blocked ? ' t360-pblock__edit--off' : ''}`}
        aria-disabled={blocked}
        title={blocked ? 'Save or cancel the open card first' : `Edit ${CARD_TITLES[k]}`}
        aria-label={`Edit ${CARD_TITLES[k]}`}
        onClick={() => {
          if (!blocked) startEdit(k);
        }}
      >
        Edit
      </Button>
    );
  };

  // A render helper (NOT a component): declaring a component inside render would
  // remount the card — and drop input focus — on every keystroke.
  const renderCard = (k: CardKey, opts: { full?: boolean; link?: { label: string; to: T360Section } }, children: ReactNode): JSX.Element => {
    const { full, link } = opts;
    const on = editing === k;
    return (
      <div key={k} className={`t360-card t360-pblock${full === true ? ' t360-pblock--full' : ''}${on ? ' t360-pblock--editing' : ''}`} data-testid={`t360-pblock-${k}`}>
        <div className="t360-pblock__hd">
          <span className="t360-pblock__n">{k}</span>
          <span className="t360-card__title">{CARD_TITLES[k]}</span>
          {link !== undefined && !on ? (
            <Button unstyled type="button" className="t360-pblock__link" onClick={() => go(link.to)}>
              {link.label}
            </Button>
          ) : null}
          {editButton(k)}
        </div>
        {on && formError !== null ? (
          <div className="t360-ferr t360-ferr--card" role="alert">
            {formError}
          </div>
        ) : null}
        {children}
      </div>
    );
  };

  const block = (k: Exclude<CardKey, '06' | '09'>, opts: { full?: boolean; link?: { label: string; to: T360Section } } = {}): JSX.Element =>
    renderCard(k, opts, editing === k ? editFields(k) : <ReadRows rows={readRows[k]} updated={updated} hydration={data.hydration} />);

  // Work history: the dedicated read (newest first); the Talent 360 read when it is unavailable.
  const history =
    data.workHistory !== null
      ? [...data.workHistory]
          .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
          .map((w) => ({ key: w.id, role: w.role_title, org: w.employer_name, span: span(w.start_date, w.end_date), src: workHistorySourceLabel(w.source), ok: w.verified }))
      : model.profile.work_history.map((w, i) => ({ key: `${w.role}-${i}`, role: w.role, org: w.organization, span: w.span, src: w.source !== null && w.source !== undefined ? workHistorySourceLabel(w.source) : '', ok: false }));
  const skillChips = rec !== null ? splitSkills(rec.key_skills ?? '') : model.profile.skills.map((s) => s.label);

  const addSkill = (): void => {
    const v = skillInput.trim();
    if (v === '') return;
    if (!skills.some((s) => s.toLowerCase() === v.toLowerCase())) setSkills((xs) => [...xs, v]);
    setSkillInput('');
  };
  const setWhField = (i: number, key: 'role_title' | 'employer_name' | 'start_date' | 'end_date', v: string): void =>
    setWh((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  return (
    <div className="t360-profile" data-testid="t360-profile">
      <div className="t360-card t360-card--prof">
        <div className="t360-phead">
          <span className="t360-sect__title">Profile</span>
          <span className="t360-caption t360-caption--inline">
            {canEdit
              ? 'Edit any card in place · one card at a time · Open Edit talent to change everything at once.'
              : 'Read-only · you don’t have permission to edit talent.'}
          </span>
          {canEdit ? (
            <Link to={`/talent/${talentId}/edit`} className="t360-btn t360-btn--neutral t360-btn--sm t360-ml-auto">
              Open Edit talent
            </Link>
          ) : null}
        </div>
        {data.status === 'loading' ? <div className="t360-empty">Loading the talent record…</div> : null}
      </div>

      <div className="t360-pgrid">
        {block('01')}
        {block('02')}
        {block('03')}
        {block('04', { link: { label: 'Details →', to: 'auth' } })}
        {block('05')}
        {block('07')}
        {block('08', { full: true, link: { label: 'Activity notes →', to: 'notes' } })}
      </div>

      <div className={`t360-card t360-pwide${editing === '06' ? ' t360-pblock--editing' : ''}`} data-testid="t360-pblock-06">
        <div className="t360-pblock__hd t360-pblock__hd--skills">
          <span className="t360-pblock__n">06</span>
          <span className="t360-card__title">Skills</span>
          {editButton('06')}
        </div>
        {editing === '06' && formError !== null ? <div className="t360-ferr t360-ferr--card" role="alert">{formError}</div> : null}
        {editing === '06' ? (
          <div className="t360-skills t360-mb8">
            {skills.map((s) => (
              <span key={s} className="t360-skill t360-skill--edit">
                {s}
                <Button unstyled type="button" className="t360-skill__x" aria-label={`Remove ${s}`} onClick={() => setSkills((xs) => xs.filter((x) => x !== s))}>
                  ×
                </Button>
              </span>
            ))}
            <Input
              unstyled
              className="t360-skilladd"
              aria-label="Add a skill"
              placeholder="Add a skill · Enter"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSkill();
                }
              }}
            />
          </div>
        ) : skillChips.length > 0 ? (
          <div className="t360-skills t360-mb8">
            {/* No corroboration source is returned yet — every chip is self-reported (never faked green). */}
            {skillChips.map((s) => (
              <span key={s} className="t360-skill" title="Self-reported">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <div className="t360-empty">No skills on record.</div>
        )}
        <div className="t360-note t360-note--flat">{updated.has('key_skills') ? 'Updated just now by you · ' : ''}Green = backed by resume and a second source. Others are self-reported.</div>
      </div>

      <div className={`t360-card t360-pwide t360-pwide--rows${editing === '09' ? ' t360-pblock--editing' : ''}`} data-testid="t360-pblock-09">
        <div className="t360-pblock__hd t360-pblock__hd--rows">
          <span className="t360-pblock__n">09</span>
          <span className="t360-card__title">Work history</span>
          <span className="t360-caption t360-caption--inline">{updated.has('work_history') ? 'Declared roles · updated just now by you' : 'Declared roles'}</span>
          {editButton('09')}
        </div>
        {editing === '09' && formError !== null ? <div className="t360-ferr t360-ferr--card" role="alert">{formError}</div> : null}
        {editing === '09' ? (
          <>
            <Button unstyled type="button" className="t360-addrole" onClick={() => setWh((rows) => [{ role_title: '', employer_name: '' }, ...rows])}>
              + Add role
            </Button>
            {wh.map((w, i) => (
              <div key={i} className="t360-whedit">
                <span>
                  <Input unstyled className={`t360-ctl${errors[`wh-${i}-role`] !== undefined ? ' t360-ctl--err' : ''}`} aria-label={`Role ${i + 1}`} placeholder="Role *" value={w.role_title} onChange={(e) => setWhField(i, 'role_title', e.target.value)} />
                  {errors[`wh-${i}-role`] !== undefined ? <span className="t360-ferr">Required</span> : null}
                </span>
                <span>
                  <Input unstyled className={`t360-ctl${errors[`wh-${i}-org`] !== undefined ? ' t360-ctl--err' : ''}`} aria-label={`Organization ${i + 1}`} placeholder="Organization *" value={w.employer_name} onChange={(e) => setWhField(i, 'employer_name', e.target.value)} />
                  {errors[`wh-${i}-org`] !== undefined ? <span className="t360-ferr">Required</span> : null}
                </span>
                <span className="t360-ctlpair">
                  <Input unstyled className="t360-ctl" aria-label={`Start ${i + 1}`} placeholder="Start" value={w.start_date ?? ''} onChange={(e) => setWhField(i, 'start_date', e.target.value)} />
                  <Input unstyled className="t360-ctl" aria-label={`End ${i + 1}`} placeholder="End" value={w.end_date ?? ''} onChange={(e) => setWhField(i, 'end_date', e.target.value)} />
                </span>
                <Button unstyled type="button" className="t360-whedit__x" aria-label={`Remove role ${i + 1}`} onClick={() => setWh((rows) => rows.filter((_, j) => j !== i))}>
                  ×
                </Button>
              </div>
            ))}
          </>
        ) : (
          <>
            {history.length === 0 ? <div className="t360-hrow t360-pempty">No work history on record.</div> : null}
            {history.map((w) => (
              <div key={w.key} className="t360-hrow">
                <span className="t360-hrow__main">
                  <b>{w.role}</b> · {w.org}
                </span>
                <span className="t360-hrow__span">{w.span}</span>
                {w.src !== '' ? <span className={`t360-hrow__src${w.ok ? ' t360-hrow__src--ok' : ''}`}>{w.src}</span> : null}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="t360-card t360-pwide t360-pwide--rows" data-testid="t360-pblock-10">
        <div className="t360-pblock__hd t360-pblock__hd--rows">
          <span className="t360-pblock__n">10</span>
          <span className="t360-card__title">Education</span>
          <span className="t360-caption t360-caption--inline">
            {canEdit ? 'Declared · changes save right away · earlier entries are kept in history' : 'Declared · read-only'}
          </span>
        </div>
        {/* ATS-QA-1 I-4 — read from the Talent 360 response (TalentEducationEntry,
            the only education authority); add / correct / remove need talent:edit. */}
        <EducationEditor
          talentId={talentId}
          entries={education}
          canEdit={canEdit && h.record_status === 'live'}
          onChange={setEducation}
          notify={notify}
          variant="t360"
        />
        {/* Certifications are stored separately and have no read yet — say so rather than imply none. */}
        <div className="t360-note t360-note--flat">Certifications are kept separately and are not shown here yet.</div>
      </div>
    </div>
  );
}
