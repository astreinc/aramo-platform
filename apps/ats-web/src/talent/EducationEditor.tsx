import { ApiError, Button, Input } from '@aramo/fe-foundation';
import { useState } from 'react';

import type { EducationEntryView } from '../talent-360/talent-360-types';

import {
  addTalentEducation,
  correctTalentEducation,
  educationSourceLabel,
  removeTalentEducation,
  type EducationEntryInput,
} from './talent-education-api';
import './education-editor.css';

// ATS-QA-1 I-4 (L2) — the education list + editor, shared by Talent 360 → Profile
// and Edit talent. Each add / correction / removal is saved immediately through
// the education API (not with the rest of the form). The server never overwrites:
// a correction writes a new entry and keeps the old one as history, a removal
// hides the entry but keeps it as history. Certifications are not edited here.

interface Draft {
  institution_name: string;
  degree_name: string;
  field_of_study: string;
  conferred_date: string;
}

const EMPTY: Draft = { institution_name: '', degree_name: '', field_of_study: '', conferred_date: '' };

type Mode = { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'remove'; id: string } | null;

export interface EducationEditorProps {
  readonly talentId: string;
  readonly entries: readonly EducationEntryView[];
  /** talent:edit — shows Add / Edit / Remove. */
  readonly canEdit: boolean;
  readonly onChange: (entries: readonly EducationEntryView[]) => void;
  readonly notify?: (msg: string) => void;
  /** Styling family of the host surface. */
  readonly variant: 't360' | 'form';
}

export function educationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'You do not have permission to edit this talent’s education.';
    if (error.status === 404) return 'This entry or talent record is no longer available. Reload to see the current education.';
    if (error.status === 409) return 'This entry was already changed by someone else. Reload to see the current education.';
    if (error.status === 422) return 'This talent record was merged into another record and is read-only.';
    if (error.status === 400) return 'Check the entry: institution and degree are required, and the date must be a full date.';
  }
  return 'The education entry could not be saved. Please try again.';
}

function dateText(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function draftOf(e: EducationEntryView): Draft {
  return {
    institution_name: e.institution_name,
    degree_name: e.degree_name,
    field_of_study: e.field_of_study ?? '',
    conferred_date: e.conferred_date ?? '',
  };
}

function bodyOf(d: Draft): EducationEntryInput {
  return {
    institution_name: d.institution_name.trim(),
    degree_name: d.degree_name.trim(),
    field_of_study: d.field_of_study.trim() === '' ? null : d.field_of_study.trim(),
    conferred_date: d.conferred_date.trim() === '' ? null : d.conferred_date.trim(),
  };
}

export function EducationEditor({ talentId, entries, canEdit, onChange, notify, variant }: EducationEditorProps): JSX.Element {
  const [mode, setMode] = useState<Mode>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const t = variant === 't360';
  const ctl = t ? 't360-ctl' : 'rc-input';
  const btn = t ? 't360-btn t360-btn--neutral t360-btn--sm' : 'rc-btn rc-btn--sm';
  const primary = t ? 't360-btn t360-btn--primary t360-btn--sm' : 'rc-btn rc-btn--primary rc-btn--sm';

  const open = (m: Mode, d: Draft = EMPTY): void => {
    setMode(m);
    setDraft(d);
    setErrors({});
    setFormError(null);
  };
  const close = (): void => open(null);

  const validate = (): boolean => {
    const e: Partial<Record<keyof Draft, string>> = {};
    if (draft.institution_name.trim() === '') e.institution_name = 'Required';
    if (draft.degree_name.trim() === '') e.degree_name = 'Required';
    if (draft.conferred_date.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.conferred_date.trim())) {
      e.conferred_date = 'Use a full date';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const run = async (fn: () => Promise<{ education: readonly EducationEntryView[] }>, done: string): Promise<void> => {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fn();
      onChange(res.education);
      close();
      notify?.(done);
    } catch (err) {
      setFormError(educationErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<void> => {
    if (mode === null || mode.kind === 'remove' || !validate()) return;
    const body = bodyOf(draft);
    if (mode.kind === 'add') {
      await run(() => addTalentEducation(talentId, body), 'Education added');
    } else {
      await run(() => correctTalentEducation(talentId, mode.id, body), 'Education corrected · the earlier entry is kept in history');
    }
  };

  const form = (
    <div className={t ? 't360-eduform' : 'rc-eduform'} data-testid="education-form">
      {formError !== null ? (
        <div className={t ? 't360-ferr t360-ferr--card' : 'rc-ferr'} role="alert">
          {formError}
        </div>
      ) : null}
      {(
        [
          ['institution_name', 'Institution *', 'text'],
          ['degree_name', 'Degree *', 'text'],
          ['field_of_study', 'Field of study', 'text'],
          ['conferred_date', 'Conferred date', 'date'],
        ] as const
      ).map(([key, label, type]) => (
        <span key={key} className={t ? 't360-edufield' : 'rc-edufield'}>
          <Input
            unstyled
            className={`${ctl}${errors[key] !== undefined ? (t ? ' t360-ctl--err' : ' rc-input--err') : ''}`}
            type={type}
            aria-label={label.replace(' *', '')}
            placeholder={label}
            value={draft[key]}
            disabled={saving}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          />
          {errors[key] !== undefined ? <span className={t ? 't360-ferr' : 'rc-ferr'}>{errors[key]}</span> : null}
        </span>
      ))}
      <span className={t ? 't360-eduform__actions' : 'rc-eduform__actions'}>
        <Button unstyled type="button" className={primary} disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : mode?.kind === 'edit' ? 'Save correction' : 'Add entry'}
        </Button>
        <Button unstyled type="button" className={btn} disabled={saving} onClick={close}>
          Cancel
        </Button>
      </span>
    </div>
  );

  return (
    <div className={t ? 't360-edu' : 'rc-edu'} data-testid="education-editor">
      {canEdit && mode === null ? (
        <Button unstyled type="button" className={t ? 't360-addrole' : 'rc-btn rc-btn--sm'} onClick={() => open({ kind: 'add' })}>
          + Add education
        </Button>
      ) : null}
      {mode?.kind === 'add' ? form : null}
      {entries.length === 0 && mode?.kind !== 'add' ? (
        <div className={t ? 't360-hrow t360-pempty' : 'rc-secnote'}>No education on record.</div>
      ) : null}
      {entries.map((e) => {
        if (mode?.kind === 'edit' && mode.id === e.id) return <div key={e.id}>{form}</div>;
        const when = dateText(e.conferred_date);
        return (
          <div key={e.id} className={t ? 't360-hrow' : 'rc-edu__item'} data-testid={`education-${e.id}`}>
            <span className={t ? 't360-hrow__main' : 'rc-edu__main'}>
              <b>{e.degree_name}</b>
              {e.field_of_study !== null ? `, ${e.field_of_study}` : ''} · {e.institution_name}
            </span>
            {when !== null ? <span className={t ? 't360-hrow__span' : 'rc-edu__date'}>{when}</span> : null}
            <span className={t ? 't360-hrow__src' : 'rc-secnote'}>{educationSourceLabel(e)}</span>
            {canEdit && mode === null ? (
              <span className={t ? 't360-hrow__acts' : 'rc-edu__acts'}>
                <Button unstyled type="button" className={btn} aria-label={`Edit ${e.degree_name} · ${e.institution_name}`} onClick={() => open({ kind: 'edit', id: e.id }, draftOf(e))}>
                  Edit
                </Button>
                <Button unstyled type="button" className={btn} aria-label={`Remove ${e.degree_name} · ${e.institution_name}`} onClick={() => open({ kind: 'remove', id: e.id })}>
                  Remove
                </Button>
              </span>
            ) : null}
            {mode?.kind === 'remove' && mode.id === e.id ? (
              <span className={t ? 't360-hrow__acts' : 'rc-edu__acts'} role="group" aria-label="Confirm removal">
                {formError !== null ? <span className={t ? 't360-ferr' : 'rc-ferr'} role="alert">{formError}</span> : null}
                <span>Remove this entry? It is kept in history.</span>
                <Button
                  unstyled
                  type="button"
                  className={primary}
                  disabled={saving}
                  onClick={() => void run(() => removeTalentEducation(talentId, e.id), 'Education removed · kept in history')}
                >
                  {saving ? 'Removing…' : 'Remove'}
                </Button>
                <Button unstyled type="button" className={btn} disabled={saving} onClick={close}>
                  Keep
                </Button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
