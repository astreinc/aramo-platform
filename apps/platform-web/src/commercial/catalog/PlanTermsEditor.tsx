import { type ReactNode, useState } from 'react';
import { Button, Input } from '@aramo/fe-foundation';

import type { CatalogDraftEdits, CatalogVersion } from './catalog-api';
import { parseDailyCapInput, planTermsRows } from './plan-terms-model';

// SIGN-FREE-PARITY-1 S1 / S5 (LOCKED 2026-11-27) — the version's other terms: the daily cap on envelopes,
// the allowances it carries, its description and its feature entitlements. Every viewer sees them; only a
// catalog manager edits them, and only on a DRAFT. A cap or an allowance can be removed, never added.

export const PLAN_TERMS_TITLE = 'Other terms';

export function PlanTermsEditor(props: { version: CatalogVersion; canDraft: boolean; onSave: (edits: CatalogDraftEdits) => Promise<void> }) {
  const { version, canDraft, onSave } = props;
  const editable = canDraft && version.status === 'DRAFT';
  const t = version.terms;
  const rows = planTermsRows(t);
  const [daily, setDaily] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [featureKey, setFeatureKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (edits: CatalogDraftEdits): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(edits);
      setDaily(null);
      setDescription(null);
      setFeatureKey('');
    } catch {
      setError('The draft couldn’t be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveDaily = async (): Promise<void> => {
    if (daily === null) return;
    const parsed = parseDailyCapInput(daily);
    if (!parsed.ok) {
      setError('Enter a whole number of 1 or more, or leave it empty for no daily cap.');
      return;
    }
    await save({ envelopes_per_day: parsed.value });
  };

  const row = (label: string, value: ReactNode, action: ReactNode = null) => (
    <div key={label} role="row" className="pc-diff__row">
      <span role="cell" className="pc-diff__field">
        {label}
      </span>
      <span role="cell" className="pc-diff__after">
        {value}
      </span>
      <span role="cell" className="pc-diff__mark">
        {action}
      </span>
    </div>
  );

  return (
    <div className="pc-addons" data-testid="plan-terms">
      <div className="pc-caps pc-caps--16">{PLAN_TERMS_TITLE}</div>
      <div className="pc-diff pc-diff--list" role="table" aria-label={PLAN_TERMS_TITLE}>
        {row('Envelopes per day', rows.dailyCapPresent ? rows.dailyCapText : 'No daily cap')}
        {rows.allowances.map((a) =>
          row(
            `Allowance: ${a.label}`,
            'Included',
            editable && a.removable ? (
              <Button unstyled type="button" className="pc-btn" disabled={busy} aria-label={`Remove the ${a.label} allowance`} onClick={() => void save({ remove_allowances: [a.key] })}>
                Remove
              </Button>
            ) : null,
          ),
        )}
        {row('Description', t.description ?? '—')}
        {rows.features.map((f) =>
          row(
            `Feature: ${f.label}`,
            f.enabled ? 'In plan' : 'Not in plan',
            editable ? (
              <Button unstyled type="button" className="pc-btn" disabled={busy} aria-label={`${f.enabled ? 'Take' : 'Put'} ${f.label} ${f.enabled ? 'out of' : 'in'} this plan`} onClick={() => void save({ features: { [f.key]: !f.enabled } })}>
                {f.enabled ? 'Take out' : 'Put in'}
              </Button>
            ) : null,
          ),
        )}
      </div>
      <p className="pc-addons__intro">A feature that hasn’t launched yet is never offered to subscribers, even when it’s in the plan.</p>
      {editable ? (
        <div className="pc-fields" data-testid="plan-terms-form">
          {rows.dailyCapPresent ? (
            <label className="pc-field">
              <span className="pc-field__label">Envelopes per day</span>
              <Input
                unstyled
                className="pc-input pc-input--editable"
                aria-label="Envelopes per day"
                placeholder="Empty = no daily cap"
                value={daily ?? rows.dailyCapText}
                onChange={(e) => setDaily(e.target.value)}
                onBlur={() => void saveDaily()}
              />
            </label>
          ) : null}
          <label className="pc-field">
            <span className="pc-field__label">Description</span>
            <Input
              unstyled
              className="pc-input pc-input--editable"
              aria-label="Plan description"
              maxLength={300}
              value={description ?? (t.description ?? '')}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description === null || description.trim() === (t.description ?? '')) return;
                void save({ description: description.trim() === '' ? null : description.trim() });
              }}
            />
          </label>
          <label className="pc-field">
            <span className="pc-field__label">Add a feature to this plan</span>
            <Input unstyled className="pc-input pc-input--editable" aria-label="Feature key to add" placeholder="sign.whatsapp_delivery" value={featureKey} onChange={(e) => setFeatureKey(e.target.value)} />
          </label>
          <Button unstyled type="button" className="pc-btn" disabled={busy || featureKey.trim() === ''} onClick={() => void save({ features: { [featureKey.trim()]: true } })}>
            Add feature
          </Button>
          {error !== null ? (
            <p className="pc-alert" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
