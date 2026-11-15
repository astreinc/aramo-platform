import { Input } from '@aramo/fe-foundation';

import { formatMinor, termCommitmentText, termLabel, termSavingText, type TermCode, type TermOption } from '../catalog';

// Sign Monthly and Annual-Commitment Pricing Directive v1.0 §3.5 — the Monthly / Annual choice of a plan
// that sells both terms: each option's monthly price, its commitment and the saving against Monthly.
// Shown only when a plan offers two terms (a one-term plan keeps its single price line).

export function TermChoice({
  name,
  terms,
  value,
  onChange,
  testId,
}: {
  name: string;
  terms: readonly TermOption[];
  value: TermCode | null;
  onChange: (term: TermCode) => void;
  testId: string;
}) {
  const monthly = terms.find((t) => t.term === 'MONTHLY');
  return (
    <fieldset className="sg-grid" style={{ gap: 6, border: 0, padding: 0, margin: 0 }} data-testid={testId}>
      <legend className="sg-muted" style={{ padding: 0, marginBottom: 4 }}>
        Billing option
      </legend>
      {terms.map((t) => {
        const saving = t.term === 'MONTHLY' ? null : termSavingText(t, monthly);
        return (
          <label key={t.term} className="sg-check" style={{ alignItems: 'flex-start' }} data-testid={`${testId}-${t.term}`}>
            <Input unstyled type="radio" name={name} value={t.term} checked={value === t.term} onChange={() => onChange(t.term)} />{' '}
            <span>
              <strong>
                {termLabel(t.term)} · {formatMinor(t.amount_minor, t.currency)}/month
              </strong>
              <span className="sg-muted"> · {termCommitmentText(t)}</span>
              {saving !== null ? <span className="sg-tag sg-tag--ok" style={{ marginLeft: 6 }}>{saving}</span> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
