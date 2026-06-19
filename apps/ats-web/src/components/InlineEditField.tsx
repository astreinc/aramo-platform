import { useEffect, useRef, useState } from 'react';
import { InlineAlert, useToast } from '@aramo/fe-foundation';

// PR-A2 P2 — the net-new, reusable INLINE-EDIT primitive (consumer layer;
// mirrors the existing components/Tabs.tsx pattern). The substrate-confirm
// proved nothing like this exists and libs/fe-foundation is FROZEN — so it
// lands here, designed for a future rule-of-three promotion into the
// foundation (NOT promoted this PR).
//
// INTERACTION (R5): default READ-ONLY display → click → in-place editor →
// save → back to display. NO mode-switch, NO modal. Esc cancels (reverts),
// Enter commits, blur commits. A no-op (unchanged) commit just closes.
//
// SAVE CONVENTION (R5 — the house submitting/submitError machine, NOT
// optimistic; mirrors RequisitionForm.tsx:340-650): per-field `saving` →
// `error` → success; InlineAlert variant="error" on failure; a toast on
// success (useToast). On error the editor STAYS open so the value isn't lost.
//
// AFFORDANCE (R5/R6): `canEdit` is the cosmetic gate — when false the field
// renders as plain read-only text with NO click affordance. The backend
// PATCH /:id is the real gate (per-field server-side); a forced out-of-scope
// save 403s regardless of this prop. The consumer computes `canEdit` from
// the EXISTING scope predicates (field-affordance.ts) — this primitive is
// domain-neutral and never inspects scopes itself.

const EMPTY_DISPLAY = '—';

interface InlineEditFieldProps {
  readonly label: string;
  readonly value: string | null;
  readonly canEdit: boolean;
  // Persists the new value (null = cleared). Rejects → error shown, editor
  // stays open. The consumer wires this to PATCH /v1/requisitions/:id.
  readonly onSave: (next: string | null) => Promise<void>;
  readonly type?: 'text' | 'number' | 'date';
  readonly placeholder?: string;
  // Optional display formatter (e.g. money, %). Display-only; the editor
  // edits the raw value.
  readonly format?: (value: string) => string;
  readonly multiline?: boolean;
  readonly testId?: string;
}

export function InlineEditField({
  label,
  value,
  canEdit,
  onSave,
  type = 'text',
  placeholder,
  format,
  multiline = false,
  testId,
}: InlineEditFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  // Guards a blur-after-cancel from re-triggering a commit.
  const cancellingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Keep the draft in sync when the upstream value changes while not editing
    // (e.g. a sibling field's save returns a fresh masked view).
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current !== null) inputRef.current.focus();
  }, [editing]);

  function beginEdit(): void {
    if (!canEdit || saving) return;
    setDraft(value ?? '');
    setError(null);
    setEditing(true);
  }

  function cancel(): void {
    cancellingRef.current = true;
    setEditing(false);
    setError(null);
    setDraft(value ?? '');
  }

  async function commit(): Promise<void> {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }
    const trimmed = draft.trim();
    const next: string | null = trimmed === '' ? null : trimmed;
    const current: string | null =
      value === null || value === '' ? null : value;
    if (next === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      toast.show(`${label} saved.`);
      setSaving(false);
      setEditing(false);
    } catch (err) {
      setSaving(false);
      setError(saveErrorMessage(err));
      // Editor stays open — the entered value is preserved.
    }
  }

  if (!editing) {
    const display =
      value !== null && value !== ''
        ? format !== undefined
          ? format(value)
          : value
        : EMPTY_DISPLAY;
    if (!canEdit) {
      return (
        <div className="inline-edit" data-testid={testId}>
          <span className="inline-edit__label">{label}</span>
          <span className="inline-edit__value inline-edit__value--readonly">
            {display}
          </span>
        </div>
      );
    }
    return (
      <div className="inline-edit" data-testid={testId}>
        <span className="inline-edit__label">{label}</span>
        <button
          type="button"
          className="inline-edit__display"
          onClick={beginEdit}
          aria-label={`Edit ${label}`}
        >
          <span className="inline-edit__value">{display}</span>
          <span className="inline-edit__pencil" aria-hidden="true">
            ✎
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="inline-edit inline-edit--editing" data-testid={testId}>
      <span className="inline-edit__label">{label}</span>
      <div className="inline-edit__editor">
        {multiline ? (
          <textarea
            ref={(el) => {
              inputRef.current = el;
            }}
            value={draft}
            rows={4}
            disabled={saving}
            placeholder={placeholder}
            aria-label={label}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') cancel();
            }}
            onBlur={() => void commit()}
          />
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el;
            }}
            type={type}
            value={draft}
            disabled={saving}
            placeholder={placeholder}
            aria-label={label}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void commit();
              if (ev.key === 'Escape') cancel();
            }}
            onBlur={() => void commit()}
          />
        )}
        {saving ? <span className="inline-edit__status">Saving…</span> : null}
        {error !== null ? (
          <InlineAlert variant="error">{error}</InlineAlert>
        ) : null}
      </div>
    </div>
  );
}

// --- Inline SELECT (closed vocabulary) -----------------------------------

interface InlineSelectOption {
  readonly value: string;
  readonly label: string;
}

interface InlineSelectFieldProps {
  readonly label: string;
  readonly value: string | null;
  readonly canEdit: boolean;
  readonly options: readonly InlineSelectOption[];
  readonly onSave: (next: string | null) => Promise<void>;
  // Whether the field allows an empty selection (clears to null). Required
  // fields (e.g. status) pass false.
  readonly allowEmpty?: boolean;
  readonly emptyLabel?: string;
  readonly testId?: string;
}

export function InlineSelectField({
  label,
  value,
  canEdit,
  options,
  onSave,
  allowEmpty = true,
  emptyLabel = '— Not set —',
  testId,
}: InlineSelectFieldProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const displayLabel =
    value !== null && value !== ''
      ? (options.find((o) => o.value === value)?.label ?? value)
      : EMPTY_DISPLAY;

  async function commit(raw: string): Promise<void> {
    const next: string | null = raw === '' ? null : raw;
    const current: string | null =
      value === null || value === '' ? null : value;
    if (next === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      toast.show(`${label} saved.`);
      setSaving(false);
      setEditing(false);
    } catch (err) {
      setSaving(false);
      setError(saveErrorMessage(err));
    }
  }

  if (!editing) {
    if (!canEdit) {
      return (
        <div className="inline-edit" data-testid={testId}>
          <span className="inline-edit__label">{label}</span>
          <span className="inline-edit__value inline-edit__value--readonly">
            {displayLabel}
          </span>
        </div>
      );
    }
    return (
      <div className="inline-edit" data-testid={testId}>
        <span className="inline-edit__label">{label}</span>
        <button
          type="button"
          className="inline-edit__display"
          onClick={() => {
            setError(null);
            setEditing(true);
          }}
          aria-label={`Edit ${label}`}
        >
          <span className="inline-edit__value">{displayLabel}</span>
          <span className="inline-edit__pencil" aria-hidden="true">
            ✎
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="inline-edit inline-edit--editing" data-testid={testId}>
      <span className="inline-edit__label">{label}</span>
      <div className="inline-edit__editor">
        <select
          autoFocus
          disabled={saving}
          value={value ?? ''}
          aria-label={label}
          onChange={(ev) => void commit(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        >
          {allowEmpty ? <option value="">{emptyLabel}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving ? <span className="inline-edit__status">Saving…</span> : null}
        {error !== null ? (
          <InlineAlert variant="error">{error}</InlineAlert>
        ) : null}
      </div>
    </div>
  );
}

// --- Inline CHIP input (skill / tag lists) -------------------------------
//
// Edits a string[] as removable chips + a "type a value, Enter to add"
// input. Used by the profile workbench for the required/preferred/critical
// skill lists. Same canEdit affordance + house save-state machine.

interface InlineChipInputProps {
  readonly label: string;
  readonly values: readonly string[];
  readonly canEdit: boolean;
  readonly onSave: (next: string[]) => Promise<void>;
  readonly placeholder?: string;
  readonly testId?: string;
}

export function InlineChipInput({
  label,
  values,
  canEdit,
  onSave,
  placeholder = 'Type and press Enter…',
  testId,
}: InlineChipInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([...values]);
  const [entry, setEntry] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function beginEdit(): void {
    if (!canEdit || saving) return;
    setDraft([...values]);
    setEntry('');
    setError(null);
    setEditing(true);
  }

  function addEntry(): void {
    const v = entry.trim();
    if (v === '' || draft.includes(v)) {
      setEntry('');
      return;
    }
    setDraft((d) => [...d, v]);
    setEntry('');
  }

  function removeChip(v: string): void {
    setDraft((d) => d.filter((x) => x !== v));
  }

  async function commit(): Promise<void> {
    // Fold any un-added pending entry into the list before saving.
    const pending = entry.trim();
    const finalList =
      pending !== '' && !draft.includes(pending) ? [...draft, pending] : draft;
    setSaving(true);
    setError(null);
    try {
      await onSave(finalList);
      toast.show(`${label} saved.`);
      setSaving(false);
      setEditing(false);
      setEntry('');
    } catch (err) {
      setSaving(false);
      setError(saveErrorMessage(err));
    }
  }

  function cancel(): void {
    setEditing(false);
    setError(null);
    setDraft([...values]);
    setEntry('');
  }

  if (!editing) {
    const chips = values.length > 0 ? values : null;
    return (
      <div className="inline-chips" data-testid={testId}>
        <span className="inline-edit__label">{label}</span>
        {!canEdit ? (
          <span className="inline-chips__list">
            {chips !== null
              ? chips.map((c) => (
                  <span key={c} className="inline-chips__chip">
                    {c}
                  </span>
                ))
              : EMPTY_DISPLAY}
          </span>
        ) : (
          <button
            type="button"
            className="inline-edit__display"
            onClick={beginEdit}
            aria-label={`Edit ${label}`}
          >
            <span className="inline-chips__list">
              {chips !== null
                ? chips.map((c) => (
                    <span key={c} className="inline-chips__chip">
                      {c}
                    </span>
                  ))
                : EMPTY_DISPLAY}
            </span>
            <span className="inline-edit__pencil" aria-hidden="true">
              ✎
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="inline-chips inline-chips--editing" data-testid={testId}>
      <span className="inline-edit__label">{label}</span>
      <div className="inline-edit__editor">
        <span className="inline-chips__list">
          {draft.map((c) => (
            <span key={c} className="inline-chips__chip">
              {c}
              <button
                type="button"
                className="inline-chips__remove"
                aria-label={`Remove ${c}`}
                disabled={saving}
                onClick={() => removeChip(c)}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        <input
          type="text"
          value={entry}
          disabled={saving}
          placeholder={placeholder}
          aria-label={`${label} new value`}
          onChange={(ev) => setEntry(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              addEntry();
            }
            if (ev.key === 'Escape') cancel();
          }}
        />
        <div className="inline-chips__actions">
          <button
            type="button"
            className="inline-edit__save"
            disabled={saving}
            onClick={() => void commit()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="inline-edit__cancel"
            disabled={saving}
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
        {error !== null ? (
          <InlineAlert variant="error">{error}</InlineAlert>
        ) : null}
      </div>
    </div>
  );
}

// Shared save-error mapping. The PATCH per-field gate returns 403 with a
// structured reason; surface a human message (the backend remains the
// truth — the FE affordance is cosmetic, so an out-of-scope forced save
// lands here).
function saveErrorMessage(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 403) {
    return 'You do not have permission to change this field.';
  }
  if (status === 400) {
    return 'That value is not valid. Please check and try again.';
  }
  if (status === 404) {
    return 'This requisition is no longer available.';
  }
  return 'Could not save. Please try again.';
}
