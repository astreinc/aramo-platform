import { useState } from 'react';

import { Card, CardHead, Icons, ReservedSeam } from '../ui';

import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TYPE_VALUES,
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

// The Add-Talent left column — the card-based intake form (mockup parity).
// Purely presentational: the parent (TalentCreateView) owns all state +
// the save gate. Every field maps 1:1 to a real CreateTalentRecordRequest
// key; provenance chips render REAL signal only (résumé / edited).

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
  function field(
    key: keyof IntakeState,
    label: string,
    opts: {
      type?: string;
      required?: boolean;
      full?: boolean;
      placeholder?: string;
    } = {},
  ) {
    const prov = provenance[key as string] as Provenance | undefined;
    const flagged = prov === 'resume';
    return (
      <div className={`rc-ifield${opts.full ? ' rc-ifield--full' : ''}`}>
        <label className="rc-ifield__lb">
          <span>
            {label}
            {opts.required ? <span className="rc-ifield__req"> *</span> : null}
          </span>
          <ProvenanceChip prov={prov} />
        </label>
        <input
          className={`rc-input${flagged ? ' rc-input--prov' : ''}`}
          type={opts.type ?? 'text'}
          value={values[key] as string}
          placeholder={opts.placeholder}
          aria-label={label}
          required={opts.required}
          disabled={disabled}
          onChange={(ev) => onField(key, ev.target.value)}
        />
      </div>
    );
  }

  function select(
    key: 'availability_status' | 'engagement_type',
    label: string,
    options: readonly string[],
    labels: Record<string, string>,
  ) {
    return (
      <div className="rc-ifield">
        <label className="rc-ifield__lb">
          <span>{label}</span>
          <ProvenanceChip prov={provenance[key] as Provenance | undefined} />
        </label>
        <select
          className="rc-input"
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
      </div>
    );
  }

  return (
    <div className="rc-intake">
      <Card>
        <CardHead
          title={
            <>
              <Icons.IconUser className="rc-card__hic" />
              Identity
            </>
          }
        />
        <div className="rc-fgrid">
          {field('first_name', 'First name', { required: true })}
          {field('last_name', 'Last name', { required: true })}
          {field('current_employer', 'Current employer', { full: true })}
        </div>
      </Card>

      <Card>
        <CardHead
          title={
            <>
              <Icons.IconMail className="rc-card__hic" />
              Contact
            </>
          }
        />
        <div className="rc-fgrid">
          {field('email1', 'Email', { type: 'email' })}
          {field('email2', 'Secondary email', { type: 'email' })}
          {field('phone_cell', 'Cell phone', { type: 'tel' })}
          {field('phone_home', 'Home phone', { type: 'tel' })}
          {field('phone_work', 'Work phone', { type: 'tel' })}
          {field('web_site', 'Website / portfolio', { type: 'url' })}
        </div>
      </Card>

      <Card>
        <CardHead
          title={
            <>
              <Icons.IconPin className="rc-card__hic" />
              Location
            </>
          }
        />
        <div className="rc-fgrid">
          {field('address', 'Street address', { full: true })}
          {field('city', 'City')}
          {field('state', 'State')}
          {field('zip', 'Postal code')}
          <div className="rc-ifield">
            <label className="rc-ifield__lb">
              <span>Relocation</span>
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={values.can_relocate}
              aria-label="Can relocate"
              className={`rc-toggle${values.can_relocate ? ' rc-toggle--on' : ''}`}
              disabled={disabled}
              onClick={() => onToggle('can_relocate')}
            >
              <span className="rc-toggle__sw" aria-hidden="true" />
              Can relocate
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead
          title={
            <>
              <Icons.IconContacts className="rc-card__hic" />
              Talent-stated
            </>
          }
          actions={
            <span className="rc-card__hint">
              <Icons.IconInfo />
              confirm with the talent
            </span>
          }
        />
        <div className="rc-fgrid">
          {select(
            'availability_status',
            'Availability',
            AVAILABILITY_STATUS_VALUES,
            AVAILABILITY_LABELS,
          )}
          {select(
            'engagement_type',
            'Engagement type',
            ENGAGEMENT_TYPE_VALUES,
            ENGAGEMENT_LABELS,
          )}
          {field('date_available', 'Date available', { type: 'date' })}
          {field('current_pay', 'Current pay', { placeholder: 'e.g. $72/hr' })}
          {field('desired_pay', 'Desired pay', { placeholder: 'e.g. $80/hr' })}
        </div>
        <p className="rc-fnote">
          <Icons.IconInfo />
          <span>
            Pay is free-text and talent-stated. (Commercial comp masking applies
            in the bill/pay model, not at capture.)
          </span>
        </p>
      </Card>

      <Card>
        <CardHead
          title={
            <>
              <Icons.IconTag className="rc-card__hic" />
              Skills
            </>
          }
          actions={
            skillsFromResume ? (
              <span className="rc-prov rc-prov--resume">
                <Icons.IconFile />
                parsed
              </span>
            ) : undefined
          }
        />
        <SkillsEditor
          skills={skills}
          disabled={disabled}
          onAdd={onAddSkill}
          onRemove={onRemoveSkill}
        />
        <p className="rc-fnote">
          <Icons.IconInfo />
          <span>
            Stored as free text. Canonical skill evidence is produced later by
            the Skills Taxonomy — no rating is applied here.
          </span>
        </p>
      </Card>

      <ReservedSeam
        title="Work history & education"
        tag="Capture coming soon"
      >
        Work history and education are captured as structured evidence with
        Aramo Core. For now, add them in the résumé and recruiter notes.
      </ReservedSeam>

      <Card>
        <CardHead
          title={
            <>
              <Icons.IconList className="rc-card__hic" />
              Notes &amp; flags
            </>
          }
        />
        <div className="rc-ifield rc-ifield--full">
          <label className="rc-ifield__lb">
            <span>Recruiter notes</span>
          </label>
          <textarea
            className="rc-input rc-input--area"
            value={values.notes}
            aria-label="Recruiter notes"
            placeholder="Context, screening notes…"
            rows={3}
            disabled={disabled}
            onChange={(ev) => onField('notes', ev.target.value)}
          />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={values.is_hot}
          aria-label="Mark as hot talent"
          className={`rc-toggle rc-toggle--hot${values.is_hot ? ' rc-toggle--on' : ''}`}
          disabled={disabled}
          onClick={() => onToggle('is_hot')}
        >
          <span className="rc-toggle__sw" aria-hidden="true" />
          Mark as hot talent
        </button>
      </Card>
    </div>
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
          className="rc-input"
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
