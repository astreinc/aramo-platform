import { useState, type ReactNode } from 'react';

import { Icons } from '../ui';
import { AddressTypeahead } from '../companies/AddressTypeahead';

import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TYPE_VALUES,
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
} from './stated-fields';
import { ProvenanceChip, type Provenance, type ProvenanceMap } from './provenance';
import type { IntakeState } from './intake-fields';

interface IntakeFormProps {
  readonly values: IntakeState;
  readonly provenance: ProvenanceMap;
  readonly skills: readonly string[];
  readonly skillsFromResume: boolean;
  readonly disabled?: boolean;
  readonly onField: (key: keyof IntakeState, value: string) => void;
  readonly onToggle: (key: 'can_relocate' | 'is_hot') => void;
  readonly onAddSkill: (skill: string) => void;
  readonly onRemoveSkill: (index: number) => void;
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
  skills,
  skillsFromResume,
  disabled = false,
  onField,
  onToggle,
  onAddSkill,
  onRemoveSkill,
}: IntakeFormProps) {
  // A section is tagged "FROM RESUME" when the resume parse populated any of
  // its fields (real provenance signal, not a static badge).
  const parsed = skillsFromResume || Object.values(provenance).includes('resume');

  function field(
    key: keyof IntakeState,
    label: string,
    opts: { type?: string; required?: boolean; full?: boolean; placeholder?: string } = {},
  ) {
    const prov = provenance[key as string] as Provenance | undefined;
    const flagged = prov === 'resume';
    return (
      <label className={`rc-secfield${opts.full ? ' rc-secfield--full' : ''}`}>
        <span className="rc-secfield__lb">
          <span>
            {label}
            {opts.required ? <span className="rc-secfield__req"> *</span> : null}
          </span>
          <ProvenanceChip prov={prov} />
        </span>
        <input
          className={`rc-secinput${flagged ? ' rc-secinput--prov' : ''}`}
          type={opts.type ?? 'text'}
          value={values[key] as string}
          placeholder={opts.placeholder}
          aria-label={label}
          required={opts.required}
          disabled={disabled}
          onChange={(ev) => onField(key, ev.target.value)}
        />
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

      <Section label="Skills" tag={parsed ? 'FROM RESUME' : undefined}>
        <div className="rc-secfield rc-secfield--full">
          <SkillsEditor
            skills={skills}
            disabled={disabled}
            onAdd={onAddSkill}
            onRemove={onRemoveSkill}
          />
          <p className="rc-secnote">
            Stored as free text. Canonical skill evidence is produced later by the
            Skills Taxonomy — no rating is applied here.
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

      <Section label="Employment · education · certifications" tag="AFTER CREATION">
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
  children,
}: {
  readonly label: string;
  readonly tag?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="rc-seccard">
      <div className="rc-seccard__hd">
        <span className="rc-seccard__lb">{label}</span>
        {tag !== undefined ? <span className="rc-seccard__tag">{tag}</span> : null}
      </div>
      <div className="rc-secfields">{children}</div>
    </section>
  );
}

interface SkillsEditorProps {
  readonly skills: readonly string[];
  readonly disabled: boolean;
  readonly onAdd: (skill: string) => void;
  readonly onRemove: (index: number) => void;
}

function SkillsEditor({ skills, disabled, onAdd, onRemove }: SkillsEditorProps) {
  const [draft, setDraft] = useState('');
  function commit() {
    const s = draft.trim();
    if (s !== '') onAdd(s);
    setDraft('');
  }
  return (
    <div className="rc-skills">
      <ul className="rc-skills__list">
        {skills.map((s, i) => (
          <li key={`${s}-${i}`} className="rc-skill">
            {s}
            <button
              type="button"
              aria-label={`Remove ${s}`}
              className="rc-skill__x"
              disabled={disabled}
              onClick={() => onRemove(i)}
            >
              <Icons.IconX />
            </button>
          </li>
        ))}
      </ul>
      <div className="rc-skills__add">
        <input
          className="rc-secinput"
          type="text"
          value={draft}
          aria-label="Add a skill"
          placeholder="Add a skill"
          disabled={disabled}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              commit();
            }
          }}
        />
        <button
          type="button"
          className="rc-skills__addbtn"
          disabled={disabled || draft.trim() === ''}
          onClick={commit}
        >
          <Icons.IconPlus />
          Add
        </button>
      </div>
    </div>
  );
}
