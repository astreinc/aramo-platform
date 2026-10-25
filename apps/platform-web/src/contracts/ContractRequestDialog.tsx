import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Input, TextArea } from '@aramo/fe-foundation';

import './contracts.css';

// CCP-B4 — the change-request dialog of the Contracts screen (handoff §5.10, the
// CCP dialog pattern; Commercial Control Plane v1.0.dc.html:497-525): fields →
// Before → after diff → approval-chain strip → typed confirm → refusal alert;
// footer Cancel · commit. It CREATES A CHANGE REQUEST only; nothing is applied
// until the request's chain is signed (PBD §5.3 common HALT: no direct mutation).
//
// Accessibility (PLATFORM-UX-1 §15; handoff §9): role="dialog" aria-modal,
// labelled by its title; focus moves to the first field on open, Tab is trapped,
// Esc closes, and focus returns to the opener; the refusal is role="alert".

export interface DialogField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'area';
  readonly placeholder: string;
}

export interface DiffLine {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

export interface ContractRequestDialogProps {
  readonly title: string;
  readonly sub: string;
  readonly fields: readonly DialogField[];
  readonly diff: (values: Readonly<Record<string, string>>) => readonly DiffLine[];
  /** The approval chain the server resolves for this action (label + steps). */
  readonly chain: { readonly label: string; readonly steps: string; readonly note: string };
  /** A token the operator must type exactly (End contract). */
  readonly typed?: string;
  readonly tone: 'terra' | 'danger';
  readonly commitLabel: string;
  readonly onCancel: () => void;
  /** Resolves on success; rejects with the refusal text to show. */
  readonly onCommit: (values: Readonly<Record<string, string>>) => Promise<void>;
}

const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ContractRequestDialog(props: ContractRequestDialogProps) {
  const { title, sub, fields, diff, chain, typed, tone, commitLabel, onCancel, onCommit } = props;
  const titleId = useId();
  const subId = useId();
  const typedId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [typedValue, setTypedValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>('input, textarea');
    first?.focus();
    return () => {
      const o = opener.current as HTMLElement | null;
      if (o && typeof o.focus === 'function' && document.contains(o)) o.focus();
    };
  }, []);

  const filled = fields.every((f) => (values[f.key] ?? '').trim().length > 0);
  const typedOk = typed === undefined || typedValue === typed;
  const canCommit = filled && typedOk && !busy;
  const lines = diff(values);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || dialogRef.current === null) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (firstEl === undefined || lastEl === undefined) return;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  const commit = async () => {
    if (!canCommit) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="ccp-dlg-overlay">
      <div ref={dialogRef} className="ccp-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subId} onKeyDown={onKeyDown}>
        <div className="ccp-dlg__head">
          <h2 id={titleId}>{title}</h2>
          <p id={subId}>{sub}</p>
        </div>
        <div className="ccp-dlg__body">
          {fields.map((f) => (
            <label key={f.key} className="ccp-dlg__field">
              <span className="ccp-dlg__label">{f.label}</span>
              {f.kind === 'text' ? (
                <Input
                  unstyled
                  className="ccp-dlg__input"
                  value={values[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ) : (
                <TextArea
                  unstyled
                  className="ccp-dlg__area"
                  rows={3}
                  value={values[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
            </label>
          ))}
          <div className="ccp-dlg__diffwrap">
            <div className="ccp-diff__label">Before → after</div>
            <div className="ccp-diff">
              {lines.map((d) => {
                const changed = d.before !== d.after;
                return (
                  <div key={d.field} className={`ccp-diff__row${changed ? ' ccp-diff__row--changed' : ''}`}>
                    <span className="ccp-diff__f">
                      {changed ? '~' : ''} {d.field}
                    </span>
                    <span className="ccp-diff__b">
                      {changed ? <span className="ccp-sr-only">before: </span> : null}
                      {d.before}
                    </span>
                    <span className="ccp-diff__a">
                      {changed ? <span className="ccp-sr-only">after: </span> : null}
                      {d.after}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="ccp-chain">
            <span className="ccp-chain__k">Approval chain</span>
            <b>{chain.label}</b>
            <span className="ccp-chain__steps">{chain.steps}</span>
            <span className="ccp-chain__note">{chain.note}</span>
          </div>
          {typed !== undefined ? (
            <label className="ccp-dlg__field" htmlFor={typedId}>
              <span className="ccp-dlg__label">
                Type <span className="ccp-dlg__token">{typed}</span> to confirm
              </span>
              <Input unstyled id={typedId} className="ccp-dlg__input ccp-dlg__input--typed" value={typedValue} autoComplete="off" spellCheck={false} onChange={(e) => setTypedValue(e.target.value)} />
            </label>
          ) : null}
          {error !== null ? (
            <div role="alert" className="ccp-dlg__alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="ccp-dlg__foot">
          <Button unstyled className="ccp-dlg__btn" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            unstyled
            className={`ccp-dlg__btn ccp-dlg__btn--commit ccp-dlg__btn--${tone}`}
            disabled={!canCommit}
            aria-busy={busy || undefined}
            onClick={() => void commit()}
          >
            {commitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
