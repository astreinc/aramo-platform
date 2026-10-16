import { Link } from 'react-router-dom';

import { Button } from '../ui';
import {
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  WORK_AUTHORIZATION_LABELS,
} from '../talent/stated-fields';
import type { TalentRecordView, WorkHistoryView } from '../talent/types';

import { labelize, type T360Section } from './t360-model';
import type { Talent360View as Model } from './talent-360-types';

// Talent 360 → Profile (§8A): a READ-ONLY mirror of Edit talent, in the same
// section order. Sources: the full record (getTalent — same read + scope gate as
// Edit talent) and declared work history (GET /talent-records/:id/work-history),
// both loaded lazily by the page; the Talent 360 read is the fallback when the
// full record is unavailable (404/403 — e.g. a user at another site). Each field
// is shown from exactly one source; nothing is merged or derived.

export interface ProfileData {
  /** 'fallback' = the full record could not be read; only the Talent 360 read is used. */
  readonly status: 'loading' | 'ready' | 'fallback';
  readonly record: TalentRecordView | null;
  readonly workHistory: readonly WorkHistoryView[] | null;
}

interface Row {
  readonly l: string;
  readonly v: string | null;
  readonly src?: string;
  readonly href?: string;
  readonly mono?: boolean;
  readonly pre?: boolean;
}

interface BlockDef {
  readonly n: string;
  readonly title: string;
  /** Edit talent section id (IntakeForm Section ids). */
  readonly editKey: string;
  readonly rows: readonly Row[];
  readonly full?: boolean;
  readonly link?: { readonly label: string; readonly to: T360Section };
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

function yearOf(iso: string | null): string | null {
  if (iso === null) return null;
  const m = /^(\d{4})/.exec(iso);
  return m?.[1] ?? null;
}

function span(start: string | null, end: string | null): string {
  const s = yearOf(start);
  const e = yearOf(end);
  if (s === null && e === null) return '';
  return `${s ?? ''} – ${e ?? 'Present'}`;
}

function editHref(talentId: string, key: string): string {
  return `/talent/${talentId}/edit?section=${key}`;
}

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

function Block({ b, talentId, canEdit, go }: { b: BlockDef; talentId: string; canEdit: boolean; go: (s: T360Section) => void }): JSX.Element {
  const link = b.link;
  return (
    <div className={`t360-card t360-pblock${b.full === true ? ' t360-pblock--full' : ''}`} data-testid={`t360-pblock-${b.n}`}>
      <div className="t360-pblock__hd">
        <span className="t360-pblock__n">{b.n}</span>
        <span className="t360-card__title">{b.title}</span>
        {link !== undefined ? (
          <Button unstyled type="button" className="t360-pblock__link" onClick={() => go(link.to)}>
            {link.label}
          </Button>
        ) : null}
        {canEdit ? (
          <Link to={editHref(talentId, b.editKey)} className="t360-pblock__edit">
            Edit
          </Link>
        ) : null}
      </div>
      {b.rows.map((r) => (
        <div key={r.l} className="t360-prow2">
          <span className="t360-prow2__l">{r.l}</span>
          <span className="t360-min0">
            <Value r={r} />
            {r.src !== undefined ? <span className="t360-prow2__s">{r.src}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface ProfileSectionProps {
  readonly model: Model;
  readonly data: ProfileData;
  readonly talentId: string;
  readonly canEdit: boolean;
  /** Current pay is shown only to the Edit talent audience (talent:edit). */
  readonly canSeePay: boolean;
  readonly go: (s: T360Section) => void;
}

export function ProfileSection({ model, data, talentId, canEdit, canSeePay, go }: ProfileSectionProps): JSX.Element {
  const h = model.header;
  const rec = data.record;
  const fallback = data.status !== 'ready';
  const blockEdit = canEdit && !fallback;
  const id = model.identity;

  const identityRows: Row[] = [
    { l: 'Name', v: rec !== null ? `${rec.first_name} ${rec.last_name}`.trim() : h.display_name },
    { l: 'Title', v: present(rec !== null ? rec.title : h.title) },
    {
      l: 'Primary email',
      v: present(rec !== null ? rec.email1 : h.email),
      ...(id?.primary_email_confirmed === true ? { src: 'Confirmed' } : {}),
    },
    ...(present(rec?.email2) !== null ? [{ l: 'Secondary email', v: rec?.email2 ?? null }] : []),
    {
      l: 'Mobile',
      v: present(rec !== null ? rec.phone_cell : h.phone),
      ...(id?.mobile_confirmed === true ? { src: 'Confirmed by SMS code' } : {}),
    },
    {
      l: 'Home / work phone',
      v: present([rec?.phone_home, rec?.phone_work].filter((x): x is string => present(x) !== null).join(' · ')),
    },
    { l: 'Best time to call', v: present(rec?.best_time_to_call) },
    (() => {
      const w = present(rec?.web_site);
      return w !== null ? { l: 'Website', v: w, href: websiteHref(w) } : { l: 'Website', v: null };
    })(),
  ];

  const cityState =
    rec !== null
      ? present([[rec.city, rec.state].filter((x) => present(x) !== null).join(', '), rec.zip].filter((x) => present(x) !== null).join(' '))
      : present(h.location);
  const locationRows: Row[] = [
    { l: 'Address', v: present([rec?.address, rec?.address2].filter((x): x is string => present(x) !== null).join(', ')) },
    { l: 'City / state', v: cityState },
    { l: 'Country', v: present(rec?.country) },
    { l: 'Can relocate', v: rec === null ? null : rec.can_relocate ? 'Yes' : 'No' },
  ];

  const professionalRows: Row[] = [
    { l: 'Current employer', v: present(rec?.current_employer) },
    { l: 'Experience', v: present(h.experience_summary) },
  ];

  const authRows: Row[] = [
    { l: 'Status', v: label(WORK_AUTHORIZATION_LABELS, rec !== null ? rec.work_authorization : h.work_authorization) },
    { l: 'Sponsorship', v: null },
    { l: 'Document', v: null, src: 'Collected at pre-start' },
  ];

  const availabilityRows: Row[] = [
    { l: 'Availability', v: label(AVAILABILITY_LABELS, rec !== null ? rec.availability_status : h.availability.status) },
    { l: 'Available from', v: dateLabel(rec?.date_available ?? null) },
    { l: 'Engagement', v: label(ENGAGEMENT_LABELS, rec !== null ? rec.engagement_type : h.engagement_type) },
    { l: 'Desired rate', v: present(rec !== null ? rec.desired_pay : h.desired_compensation), mono: true },
    ...(canSeePay ? [{ l: 'Current pay', v: present(rec?.current_pay), mono: true, src: 'Visible to recruiters only' }] : []),
    { l: 'Hot talent', v: rec === null ? null : rec.is_hot ? 'Yes' : 'No' },
  ];

  const owners = [...new Set((model.opportunities?.active ?? []).map((o) => o.owner_label).filter((x): x is string => present(x) !== null))];
  const sourceRows: Row[] = [
    { l: 'Source', v: present(rec !== null ? rec.source : model.relationship.ownership.source) },
    { l: 'Record added by', v: present(model.relationship.ownership.owner_provenance?.name) },
    { l: 'Currently working with', v: owners.length > 0 ? owners.join(' · ') : null, src: 'Per requisition — no talent-level owner' },
  ];

  const blocks: BlockDef[] = [
    { n: '01', title: 'Identity & contact', editKey: 'identity', rows: identityRows },
    { n: '02', title: 'Location', editKey: 'location', rows: locationRows },
    { n: '03', title: 'Professional', editKey: 'professional', rows: professionalRows },
    { n: '04', title: 'Work authorization', editKey: 'work-authorization', rows: authRows, link: { label: 'Details →', to: 'auth' } },
    { n: '05', title: 'Availability & preferences', editKey: 'availability', rows: availabilityRows },
    { n: '07', title: 'Source & ownership', editKey: 'source', rows: sourceRows },
    {
      n: '08',
      title: 'Recruiter notes',
      editKey: 'notes',
      rows: [{ l: 'On the record', v: present(rec?.notes), pre: true, src: 'Separate from activity Notes' }],
      full: true,
      link: { label: 'Activity notes →', to: 'notes' },
    },
  ];

  // Work history: the dedicated read (newest first); the Talent 360 read when it is unavailable.
  const history =
    data.workHistory !== null
      ? [...data.workHistory]
          .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
          .map((w) => ({ key: w.id, role: w.role_title, org: w.employer_name, span: span(w.start_date, w.end_date), src: labelize(w.source), ok: w.verified }))
      : model.profile.work_history.map((w, i) => ({ key: `${w.role}-${i}`, role: w.role, org: w.organization, span: w.span, src: w.source ?? '', ok: false }));

  return (
    <div className="t360-profile" data-testid="t360-profile">
      <div className="t360-card t360-card--prof">
        <div className="t360-phead">
          <span className="t360-sect__title">Profile</span>
          <span className="t360-caption t360-caption--inline">Read-only view of the talent record, in the same order as Edit talent.</span>
          {canEdit ? (
            <Link to={`/talent/${talentId}/edit`} className="t360-btn t360-btn--neutral t360-btn--sm t360-ml-auto">
              Edit profile
            </Link>
          ) : null}
        </div>
        {data.status === 'loading' ? <div className="t360-empty">Loading the talent record…</div> : null}
      </div>

      <div className="t360-pgrid">
        {blocks.map((b) => (
          <Block key={b.n} b={b} talentId={talentId} canEdit={blockEdit} go={go} />
        ))}
      </div>

      <div className="t360-card t360-pwide" data-testid="t360-pblock-06">
        <div className="t360-pblock__hd t360-pblock__hd--skills">
          <span className="t360-pblock__n">06</span>
          <span className="t360-card__title">Skills</span>
          {blockEdit ? (
            <Link to={editHref(talentId, 'skills')} className="t360-pblock__edit">
              Edit
            </Link>
          ) : null}
        </div>
        {model.profile.skills.length > 0 ? (
          <div className="t360-skills t360-mb8">
            {/* No corroboration source is returned yet — every chip is self-reported (never faked green). */}
            {model.profile.skills.map((s) => (
              <span key={s.label} className="t360-skill" title="Self-reported">
                {s.label}
              </span>
            ))}
          </div>
        ) : (
          <div className="t360-empty">No skills on record.</div>
        )}
        <div className="t360-note t360-note--flat">Green = backed by résumé and a second source. Others are self-reported.</div>
      </div>

      <div className="t360-card t360-pwide t360-pwide--rows" data-testid="t360-pblock-09">
        <div className="t360-pblock__hd t360-pblock__hd--rows">
          <span className="t360-pblock__n">09</span>
          <span className="t360-card__title">Work history</span>
          <span className="t360-caption t360-caption--inline">Declared roles</span>
          {blockEdit ? (
            <Link to={editHref(talentId, 'work-history')} className="t360-pblock__edit">
              Edit
            </Link>
          ) : null}
        </div>
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
      </div>

      <div className="t360-card t360-pwide t360-pwide--rows" data-testid="t360-pblock-10">
        <div className="t360-pblock__hd t360-pblock__hd--rows">
          <span className="t360-pblock__n">10</span>
          <span className="t360-card__title">Education &amp; certifications</span>
        </div>
        {/* GAP — written at creation, no read API yet (§8A.5). "None on record" would be untrue. */}
        <div className="t360-hrow t360-pempty">Saved when the talent was created — not readable yet.</div>
      </div>
    </div>
  );
}
