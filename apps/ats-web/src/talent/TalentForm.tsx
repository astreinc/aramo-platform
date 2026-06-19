import { useEffect, useRef, useState } from 'react';
import { Button, FormField, InlineAlert, Switch } from '@aramo/fe-foundation';

import type {
  CreateTalentRecordRequest,
  TalentRecordPrefill,
  TalentRecordView,
  UpdateTalentRecordRequest,
} from './types';

// R5 — the shared talent CREATE/EDIT composite. The route wrappers
// (TalentCreateView / TalentEditView) handle params + pre-fetch + the
// résumé section + the create/attach orchestration; this component
// owns the field-by-field form state + the buildCreateBody / buildPatchBody
// construction (R4 omit-vs-null discipline).
//
// Ruling 4 boundaries:
//   - the Core-Talent link field is NOT surfaced (dedicated /link
//     routes own it; see UpdateTalentRecordRequest comment for the
//     PR-A5b-2 rationale)
//   - key_skills is a textarea (free-text — NOT a structured selector
//     UI; the canonical evidence model is Core-only, not recruiter-facing)
//   - current_pay / desired_pay are text inputs (free-text — NOT
//     D5-masked, distinct from the requisition's typed compensation)
//
// Prefill: the parent's `prefillPatch` prop applies a TalentRecordPrefill
// to the form (overwrites only the keys present in the prefill — see
// `applyPrefill` exposed below). For EDIT mode, `initial` pre-fills from
// TalentRecordView.

interface BasicsFormState {
  first_name: string;
  last_name: string;
  email1: string;
  email2: string;
  phone_home: string;
  phone_cell: string;
  phone_work: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  source: string;
  key_skills: string;
  current_employer: string;
  current_pay: string;
  desired_pay: string;
  date_available: string;
  can_relocate: boolean;
  is_hot: boolean;
  notes: string;
  web_site: string;
  best_time_to_call: string;
}

type FormState = BasicsFormState;

function emptyState(): FormState {
  return {
    first_name: '',
    last_name: '',
    email1: '',
    email2: '',
    phone_home: '',
    phone_cell: '',
    phone_work: '',
    address: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    source: '',
    key_skills: '',
    current_employer: '',
    current_pay: '',
    desired_pay: '',
    date_available: '',
    can_relocate: false,
    is_hot: false,
    notes: '',
    web_site: '',
    best_time_to_call: '',
  };
}

function stateFromInitial(initial: TalentRecordView): FormState {
  return {
    first_name: initial.first_name,
    last_name: initial.last_name,
    email1: initial.email1 ?? '',
    email2: initial.email2 ?? '',
    phone_home: initial.phone_home ?? '',
    phone_cell: initial.phone_cell ?? '',
    phone_work: initial.phone_work ?? '',
    address: initial.address ?? '',
    address2: initial.address2 ?? '',
    city: initial.city ?? '',
    state: initial.state ?? '',
    zip: initial.zip ?? '',
    source: initial.source ?? '',
    key_skills: initial.key_skills ?? '',
    current_employer: initial.current_employer ?? '',
    current_pay: initial.current_pay ?? '',
    desired_pay: initial.desired_pay ?? '',
    date_available: initial.date_available ?? '',
    can_relocate: initial.can_relocate,
    is_hot: initial.is_hot,
    notes: initial.notes ?? '',
    web_site: initial.web_site ?? '',
    best_time_to_call: initial.best_time_to_call ?? '',
  };
}

// Apply a résumé prefill — only overwrites keys present in the prefill
// (a 'failed' parse with an empty prefill is a no-op). The recruiter's
// existing entries on other fields are preserved.
function applyPrefill(state: FormState, prefill: TalentRecordPrefill): FormState {
  const next: FormState = { ...state };
  for (const [k, v] of Object.entries(prefill)) {
    if (typeof v !== 'string') continue;
    (next as unknown as Record<string, string>)[k] = v;
  }
  return next;
}

function buildCreateBody(state: FormState): CreateTalentRecordRequest {
  const body: Record<string, unknown> = {
    first_name: state.first_name.trim(),
    last_name: state.last_name.trim(),
  };
  const optional: Array<keyof BasicsFormState> = [
    'email1', 'email2', 'phone_home', 'phone_cell', 'phone_work',
    'address', 'address2', 'city', 'state', 'zip',
    'source', 'key_skills', 'current_employer', 'current_pay',
    'desired_pay', 'date_available', 'notes', 'web_site',
    'best_time_to_call',
  ];
  for (const k of optional) {
    const v = state[k];
    if (typeof v === 'string' && v !== '') body[k] = v;
  }
  if (state.can_relocate) body['can_relocate'] = true;
  if (state.is_hot) body['is_hot'] = true;
  return body as unknown as CreateTalentRecordRequest;
}

function buildPatchBody(
  state: FormState,
  initial: TalentRecordView,
): UpdateTalentRecordRequest {
  const body: Record<string, unknown> = {};
  if (state.first_name !== initial.first_name) {
    body['first_name'] = state.first_name.trim();
  }
  if (state.last_name !== initial.last_name) {
    body['last_name'] = state.last_name.trim();
  }
  if (state.can_relocate !== initial.can_relocate) {
    body['can_relocate'] = state.can_relocate;
  }
  if (state.is_hot !== initial.is_hot) {
    body['is_hot'] = state.is_hot;
  }
  // Nullable strings: empty input → null (explicit clear); else send
  // if changed. Same pattern as R4's requisition PATCH.
  const initialAsRecord = initial as unknown as Record<string, unknown>;
  const nullable: Array<keyof BasicsFormState> = [
    'email1', 'email2', 'phone_home', 'phone_cell', 'phone_work',
    'address', 'address2', 'city', 'state', 'zip',
    'source', 'key_skills', 'current_employer', 'current_pay',
    'desired_pay', 'date_available', 'notes', 'web_site',
    'best_time_to_call',
  ];
  for (const k of nullable) {
    const initVal = initialAsRecord[k] ?? '';
    const cur = state[k] as string;
    if (cur !== initVal) {
      body[k] = cur === '' ? null : cur;
    }
  }
  return body as unknown as UpdateTalentRecordRequest;
}

interface CommonProps {
  readonly onCancel: () => void;
  readonly submitting?: boolean;
  readonly submitError?: string | null;
}

interface CreateProps extends CommonProps {
  readonly mode: 'create';
  readonly onSubmit: (body: CreateTalentRecordRequest) => Promise<void>;
  // The current résumé prefill (parent threads this from the upload
  // section). When it changes (non-shallow), the form merges new fields
  // in WITHOUT overwriting recruiter edits to other fields.
  readonly prefill?: TalentRecordPrefill;
}

interface EditProps extends CommonProps {
  readonly mode: 'edit';
  readonly initial: TalentRecordView;
  readonly onSubmit: (body: UpdateTalentRecordRequest) => Promise<void>;
}

type TalentFormProps = CreateProps | EditProps;

export function TalentForm(props: TalentFormProps) {
  const [state, setState] = useState<FormState>(() =>
    props.mode === 'edit' ? stateFromInitial(props.initial) : emptyState(),
  );

  // Apply prefill when the parent passes a new one (reference compare;
  // the parent creates a new object on each parse). Tracked via ref so
  // we only apply each prefill once and the recruiter's manual edits
  // are preserved on re-render.
  const lastPrefillRef = useRef<TalentRecordPrefill | undefined>(undefined);
  const currentPrefill = props.mode === 'create' ? props.prefill : undefined;
  useEffect(() => {
    if (currentPrefill === undefined) return;
    if (currentPrefill === lastPrefillRef.current) return;
    lastPrefillRef.current = currentPrefill;
    setState((s) => applyPrefill(s, currentPrefill));
  }, [currentPrefill]);

  function set<K extends keyof FormState>(key: K, next: FormState[K]): void {
    setState((s) => ({ ...s, [key]: next }));
  }

  const submitting = props.submitting === true;
  const submitError = props.submitError ?? null;
  const titleValid =
    state.first_name.trim() !== '' && state.last_name.trim() !== '';
  const canSubmit = titleValid && !submitting;

  async function onSubmit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!canSubmit) return;
    if (props.mode === 'create') {
      await props.onSubmit(buildCreateBody(state));
    } else {
      await props.onSubmit(buildPatchBody(state, props.initial));
    }
  }

  return (
    <form className="talent-form" onSubmit={onSubmit}>
      <fieldset className="talent-form__basics" disabled={submitting}>
        <legend>Identity</legend>
        <FormField label="First name">
          <input
            type="text"
            value={state.first_name}
            onChange={(ev) => set('first_name', ev.target.value)}
            aria-label="First name"
            required
          />
        </FormField>
        <FormField label="Last name">
          <input
            type="text"
            value={state.last_name}
            onChange={(ev) => set('last_name', ev.target.value)}
            aria-label="Last name"
            required
          />
        </FormField>
      </fieldset>

      <fieldset className="talent-form__contact" disabled={submitting}>
        <legend>Contact</legend>
        <FormField label="Primary email">
          <input
            type="email"
            value={state.email1}
            onChange={(ev) => set('email1', ev.target.value)}
            aria-label="Primary email"
          />
        </FormField>
        <FormField label="Secondary email">
          <input
            type="email"
            value={state.email2}
            onChange={(ev) => set('email2', ev.target.value)}
            aria-label="Secondary email"
          />
        </FormField>
        <FormField label="Cell phone">
          <input
            type="tel"
            value={state.phone_cell}
            onChange={(ev) => set('phone_cell', ev.target.value)}
            aria-label="Cell phone"
          />
        </FormField>
        <FormField label="Home phone">
          <input
            type="tel"
            value={state.phone_home}
            onChange={(ev) => set('phone_home', ev.target.value)}
            aria-label="Home phone"
          />
        </FormField>
        <FormField label="Work phone">
          <input
            type="tel"
            value={state.phone_work}
            onChange={(ev) => set('phone_work', ev.target.value)}
            aria-label="Work phone"
          />
        </FormField>
        <FormField label="Best time to call">
          <input
            type="text"
            value={state.best_time_to_call}
            onChange={(ev) => set('best_time_to_call', ev.target.value)}
            aria-label="Best time to call"
          />
        </FormField>
        <FormField label="Web site">
          <input
            type="url"
            value={state.web_site}
            onChange={(ev) => set('web_site', ev.target.value)}
            aria-label="Web site"
          />
        </FormField>
      </fieldset>

      <fieldset className="talent-form__location" disabled={submitting}>
        <legend>Location</legend>
        <FormField label="Address">
          <input
            type="text"
            value={state.address}
            onChange={(ev) => set('address', ev.target.value)}
            aria-label="Address"
          />
        </FormField>
        <FormField label="Address 2">
          <input
            type="text"
            value={state.address2}
            onChange={(ev) => set('address2', ev.target.value)}
            aria-label="Address 2"
          />
        </FormField>
        <FormField label="City">
          <input
            type="text"
            value={state.city}
            onChange={(ev) => set('city', ev.target.value)}
            aria-label="City"
          />
        </FormField>
        <FormField label="State">
          <input
            type="text"
            value={state.state}
            onChange={(ev) => set('state', ev.target.value)}
            aria-label="State"
          />
        </FormField>
        <FormField label="Zip">
          <input
            type="text"
            value={state.zip}
            onChange={(ev) => set('zip', ev.target.value)}
            aria-label="Zip"
          />
        </FormField>
      </fieldset>

      <fieldset className="talent-form__employment" disabled={submitting}>
        <legend>Employment</legend>
        <FormField label="Current employer">
          <input
            type="text"
            value={state.current_employer}
            onChange={(ev) => set('current_employer', ev.target.value)}
            aria-label="Current employer"
          />
        </FormField>
        <FormField
          label="Key skills"
          helper="Free-text — list the talent's stated skills (e.g. 'Java, Postgres, AWS')."
        >
          <textarea
            value={state.key_skills}
            onChange={(ev) => set('key_skills', ev.target.value)}
            aria-label="Key skills"
            rows={4}
          />
        </FormField>
        <FormField
          label="Current pay"
          helper="Free-text (e.g. '$85k base')."
        >
          <input
            type="text"
            value={state.current_pay}
            onChange={(ev) => set('current_pay', ev.target.value)}
            aria-label="Current pay"
          />
        </FormField>
        <FormField
          label="Desired pay"
          helper="Free-text (e.g. '$95-110k')."
        >
          <input
            type="text"
            value={state.desired_pay}
            onChange={(ev) => set('desired_pay', ev.target.value)}
            aria-label="Desired pay"
          />
        </FormField>
        <FormField label="Available from">
          <input
            type="date"
            value={state.date_available}
            onChange={(ev) => set('date_available', ev.target.value)}
            aria-label="Available from"
          />
        </FormField>
        <FormField label="Source">
          <input
            type="text"
            value={state.source}
            onChange={(ev) => set('source', ev.target.value)}
            aria-label="Source"
          />
        </FormField>
      </fieldset>

      <fieldset className="talent-form__flags" disabled={submitting}>
        <legend>Flags</legend>
        <FormField label="Can relocate">
          <Switch
            checked={state.can_relocate}
            onCheckedChange={(c) => set('can_relocate', c)}
            aria-label="Can relocate"
          />
        </FormField>
        <FormField label="Hot">
          <Switch
            checked={state.is_hot}
            onCheckedChange={(c) => set('is_hot', c)}
            aria-label="Hot"
          />
        </FormField>
        <FormField label="Notes">
          <textarea
            value={state.notes}
            onChange={(ev) => set('notes', ev.target.value)}
            aria-label="Notes"
            rows={3}
          />
        </FormField>
      </fieldset>

      {submitError !== null ? (
        <InlineAlert variant="error">{submitError}</InlineAlert>
      ) : null}

      <div className="talent-form__actions">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create talent'
              : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={props.onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
