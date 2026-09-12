import { type ReactNode } from 'react';

import { AddressTypeahead } from '../companies/AddressTypeahead';

import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TYPE_VALUES,
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
} from './stated-fields';
import {
  ProvenanceChip,
  isResumeSourced,
  type Provenance,
  type ProvenanceMap,
} from './provenance';
import type { IntakeState } from './intake-fields';
import type { WorkHistoryDraft } from './types';

interface IntakeFormProps {
  readonly values: IntakeState;
  readonly provenance: ProvenanceMap;
  readonly workHistory: readonly WorkHistoryDraft[];
  readonly disabled?: boolean;
  // Full-profile EDIT: keys rendered display-only (read-only). Email + phone are
  // the identity/dedup anchors (email is required + the primary key; email+phone
  // together identify a talent) — they are shown, never edited, on the edit form.
  readonly lockedFields?: ReadonlySet<keyof IntakeState>;
  readonly onField: (key: keyof IntakeState, value: string) => void;
  readonly onToggle: (key: 'can_relocate' | 'is_hot') => void;
  readonly onWorkHistoryField: (
    index: number,
    key: keyof WorkHistoryDraft,
    value: string,
  ) => void;
  readonly onAddWorkHistory: () => void;
  readonly onRemoveWorkHistory: (index: number) => void;
}

// The Step-2 "Review & create" body — the resume-first Add-Talent field form,
// aligned to the prototype (design/aramo-prototype/platform/Talent.dc.html):
// a grid of section cards (uppercase eyebrow + optional tag), each holding the
// real TalentRecord columns. Purely presentational — the parent
// (TalentCreateView) owns all state + the save gate. Every field maps 1:1 to a
// real CreateTalentRecordRequest key; provenance chips render REAL signal only
// (resume / edited). Contact-permission consent is governed SEPARATELY (not
// captured here). Skills/employment/education/certifications are captured as
// structured evidence AFTER creation.

export function IntakeForm({
  values,
  provenance,
  workHistory,
  disabled = false,
  lockedFields,
  onField,
  onToggle,
  onWorkHistoryField,
  onAddWorkHistory,
  onRemoveWorkHistory,
}: IntakeFormProps) {
  // A section is tagged "FROM RESUME" when the resume parse populated any of
  // its fields (real provenance signal, not a static badge).
  const parsed = Object.values(provenance).some(isResumeSourced);

  function field(
    key: keyof IntakeState,
    label: string,
    opts: { type?: string; required?: boolean; full?: boolean; placeholder?: string } = {},
  ) {
    const prov = provenance[key as string] as Provenance | undefined;
    const flagged = isResumeSourced(prov);
    const locked = lockedFields?.has(key) ?? false;
    return (
      <label className={`rc-secfield${opts.full ? ' rc-secfield--full' : ''}`}>
        <span className="rc-secfield__lb">
          <span>
            {label}
            {opts.required ? <span className="rc-secfield__req"> *</span> : null}
          </span>
          {locked ? <span className="rc-secfield__lock">Identity anchor</span> : <ProvenanceChip prov={prov} />}
        </span>
        <input
          className={`rc-secinput${flagged ? ' rc-secinput--prov' : ''}`}
          type={opts.type ?? 'text'}
          value={values[key] as string}
          placeholder={opts.placeholder}
          aria-label={label}
          required={opts.required}
          disabled={disabled || locked}
          readOnly={locked}
          onChange={(ev) => onField(key, ev.target.value)}
        />
        {locked ? (
          <p className="rc-secnote">Used to identify this talent — not editable here.</p>
        ) : null}
      </label>
    );
  }

  function select(
    key: 'availability_status' | 'engagement_type' | 'work_authorization',
    label: string,
    options: readonly string[],
    labels: Record<string, string>,
    required = false,
  ) {
    return (
      <label className="rc-secfield">
        <span className="rc-secfield__lb">
          <span>
            {label}
            {required ? <span className="rc-secfield__req"> *</span> : null}
          </span>
          <ProvenanceChip prov={provenance[key] as Provenance | undefined} />
        </span>
        <select
          className="rc-secinput"
          value={values[key]}
          aria-label={label}
          disabled={disabled}
          onChange={(ev) => onField(key, ev.target.value)}
        >
          <option value="">Not stated</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {labels[o]}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function toggle(key: 'can_relocate' | 'is_hot', label: string) {
    return (
      <div className="rc-secfield">
        <span className="rc-secfield__lb">
          <span>{label}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={values[key]}
          aria-label={label}
          className={`rc-toggle${values[key] ? ' rc-toggle--on' : ''}`}
          disabled={disabled}
          onClick={() => onToggle(key)}
        >
          <span className="rc-toggle__sw" aria-hidden="true" />
          {values[key] ? 'Yes' : 'No'}
        </button>
      </div>
    );
  }

  return (
    <div className="rc-secgrid">
      <Section label="Identity" tag={parsed ? 'FROM RESUME' : undefined}>
        {field('first_name', 'First name', { required: true })}
        {field('last_name', 'Last name', { required: true })}
        {field('title', 'Professional title', { full: true })}
      </Section>

      <Section label="Contact" tag={parsed ? 'FROM RESUME' : undefined}>
        {field('email1', 'Primary email', { type: 'email', required: true })}
        {field('email2', 'Secondary email', { type: 'email' })}
        {field('phone_cell', 'Mobile', { type: 'tel', required: true })}
        {field('phone_home', 'Home phone', { type: 'tel' })}
        {field('phone_work', 'Work phone', { type: 'tel' })}
        {field('best_time_to_call', 'Best time to call')}
        {field('web_site', 'Website / portfolio', { type: 'url', full: true })}
      </Section>

      <Section label="Location" tag={parsed ? 'FROM RESUME' : undefined}>
        {/* Address autocomplete (reuses the requisition work-location typeahead
            + /v1/address-lookup). Optional — fills the fields below, which stay
            editable. Never blocks manual entry. */}
        <div className="rc-secfield rc-secfield--full">
          <span className="rc-secfield__lb">
            <span>Search address</span>
          </span>
          <AddressTypeahead
            disabled={disabled}
            testId="talent-address-search"
            onSelectAddress={(d) => {
              onField('address', d.address ?? '');
              onField('city', d.city ?? '');
              onField('state', d.state ?? '');
              onField('zip', d.zip ?? '');
              if (d.country !== null && d.country !== '') onField('country', d.country);
            }}
          />
        </div>
        {field('address', 'Street address', { full: true })}
        {field('address2', 'Address line 2', { full: true })}
        {field('city', 'City', { required: true })}
        {field('state', 'State', { required: true })}
        {field('zip', 'Postal code')}
        {field('country', 'Country')}
        {toggle('can_relocate', 'Can relocate')}
      </Section>

      <Section label="Professional" tag={parsed ? 'FROM RESUME' : undefined}>
        {field('current_employer', 'Current employer', { full: true })}
      </Section>

      <Section label="Work authorization">
        {select(
          'work_authorization',
          'Work authorization',
          WORK_AUTHORIZATION_VALUES,
          WORK_AUTHORIZATION_LABELS,
          true,
        )}
      </Section>

      <Section label="Availability & preferences">
        {select('availability_status', 'Availability', AVAILABILITY_STATUS_VALUES, AVAILABILITY_LABELS)}
        {field('date_available', 'Available from', { type: 'date' })}
        {select('engagement_type', 'Engagement type', ENGAGEMENT_TYPE_VALUES, ENGAGEMENT_LABELS)}
        {field('desired_pay', 'Desired rate', { required: true, placeholder: '$/hr' })}
        {field('current_pay', 'Current pay', { placeholder: 'e.g. $72/hr' })}
        {toggle('is_hot', 'Hot talent')}
      </Section>

      <Section label="Skills" tag={parsed ? 'FROM RESUME' : undefined} full>
        <div className="rc-secfield rc-secfield--full">
          <span className="rc-secfield__lb">
            <span>Key skills</span>
            <ProvenanceChip prov={provenance['key_skills'] as Provenance | undefined} />
          </span>
          <textarea
            className="rc-secinput rc-secinput--area"
            value={values.key_skills}
            aria-label="Key skills"
            placeholder="e.g. C#, ASP.NET Core, Azure SQL, Kubernetes…"
            rows={4}
            disabled={disabled}
            onChange={(ev) => onField('key_skills', ev.target.value)}
          />
          <p className="rc-secnote">
            Free text — review and correct. Auto-filled from the résumé when governed
            extraction is enabled for your tenant; otherwise enter the key skills
            manually. Canonical structured skill evidence is produced separately.
          </p>
        </div>
      </Section>

      <Section label="Source context" tag="RECORDED AUTOMATICALLY">
        {field('source', 'Source relationship', {
          full: true,
          placeholder: 'e.g. Referral — via Kofi Mensah',
        })}
      </Section>

      <Section label="Ownership">
        <div className="rc-secfield">
          <span className="rc-secfield__lb">
            <span>Owner</span>
          </span>
          <input className="rc-secinput" value="You" aria-label="Owner" disabled readOnly />
        </div>
      </Section>

      <Section label="Notes">
        <div className="rc-secfield rc-secfield--full">
          <span className="rc-secfield__lb">
            <span>Recruiter notes</span>
          </span>
          <textarea
            className="rc-secinput rc-secinput--area"
            value={values.notes}
            aria-label="Recruiter notes"
            placeholder="Context, screening notes…"
            rows={3}
            disabled={disabled}
            onChange={(ev) => onField('notes', ev.target.value)}
          />
        </div>
      </Section>

      <Section
        label="Work history"
        tag={workHistory.length > 0 ? 'FROM RESUME' : undefined}
        full
      >
        <WorkHistoryEditor
          entries={workHistory}
          disabled={disabled}
          onField={onWorkHistoryField}
          onAdd={onAddWorkHistory}
          onRemove={onRemoveWorkHistory}
        />
      </Section>

      <Section label="Education · certifications" tag="AFTER CREATION" full>
        <div className="rc-secfield rc-secfield--full">
          <p className="rc-secnote">
            Added on the Talent record after creation as structured records with
            evidence — not free text.
          </p>
        </div>
      </Section>
    </div>
  );
}

function Section({
  label,
  tag,
  full = false,
  children,
}: {
  readonly label: string;
  readonly tag?: string;
  readonly full?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className={`rc-seccard${full ? ' rc-seccard--full' : ''}`}>
      <div className="rc-seccard__hd">
        <span className="rc-seccard__lb">{label}</span>
        {tag !== undefined ? <span className="rc-seccard__tag">{tag}</span> : null}
      </div>
      <div className="rc-secfields">{children}</div>
    </section>
  );
}

// Work-History review card — the recruiter edits the extracted rows before
// create (LOCKED scope expansion). Declared 'from résumé', NOT verified; the
// green VERIFIED badge appears only later on the Detail once verification runs.
function WorkHistoryEditor({
  entries,
  disabled,
  onField,
  onAdd,
  onRemove,
}: {
  readonly entries: readonly WorkHistoryDraft[];
  readonly disabled: boolean;
  readonly onField: (index: number, key: keyof WorkHistoryDraft, value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}) {
  return (
    <div className="rc-secfield rc-secfield--full">
      {entries.length === 0 ? (
        <p className="rc-secnote">
          No roles yet — add one, or roles appear here when parsed from a résumé.
        </p>
      ) : null}
      {entries.map((e, i) => (
        <div className="rc-wh__row" key={i}>
          <div className="rc-wh__grid">
            <label className="rc-secfield">
              <span className="rc-secfield__lb">
                <span>Role title<span className="rc-secfield__req"> *</span></span>
              </span>
              <input
                className="rc-secinput"
                value={e.role_title}
                aria-label={`Role title ${i + 1}`}
                disabled={disabled}
                onChange={(ev) => onField(i, 'role_title', ev.target.value)}
              />
            </label>
            <label className="rc-secfield">
              <span className="rc-secfield__lb">
                <span>Employer<span className="rc-secfield__req"> *</span></span>
              </span>
              <input
                className="rc-secinput"
                value={e.employer_name}
                aria-label={`Employer ${i + 1}`}
                disabled={disabled}
                onChange={(ev) => onField(i, 'employer_name', ev.target.value)}
              />
            </label>
            <label className="rc-secfield">
              <span className="rc-secfield__lb"><span>Start</span></span>
              <input
                className="rc-secinput"
                value={e.start_date ?? ''}
                aria-label={`Start date ${i + 1}`}
                placeholder="e.g. 2022"
                disabled={disabled}
                onChange={(ev) => onField(i, 'start_date', ev.target.value)}
              />
            </label>
            <label className="rc-secfield">
              <span className="rc-secfield__lb"><span>End</span></span>
              <input
                className="rc-secinput"
                value={e.end_date ?? ''}
                aria-label={`End date ${i + 1}`}
                placeholder="e.g. present"
                disabled={disabled}
                onChange={(ev) => onField(i, 'end_date', ev.target.value)}
              />
            </label>
          </div>
          <label className="rc-secfield rc-secfield--full">
            <span className="rc-secfield__lb"><span>Description</span></span>
            <textarea
              className="rc-secinput rc-secinput--area"
              value={e.description ?? ''}
              aria-label={`Description ${i + 1}`}
              rows={2}
              disabled={disabled}
              onChange={(ev) => onField(i, 'description', ev.target.value)}
            />
          </label>
          <div className="rc-wh__rowfoot">
            <button
              type="button"
              className="rc-wh__remove"
              disabled={disabled}
              onClick={() => onRemove(i)}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="rc-wh__addrow">
        <button type="button" className="rc-btn" disabled={disabled} onClick={onAdd}>
          + Add role
        </button>
      </div>
      <p className="rc-secnote">
        From résumé — review and correct. Saved as declared work history (not
        verified) when you create.
      </p>
    </div>
  );
}

