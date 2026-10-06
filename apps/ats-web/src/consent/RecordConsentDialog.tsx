import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  InlineAlert,
  RadioGroup,
  type RadioOption,
  useToast,
} from '@aramo/fe-foundation';

import { captureConsent, getConsentCaptureTexts } from './consent-api';
import {
  CONSENT_CAPTURE_SCOPES,
  type ConsentCaptureMethod,
  type ConsentCaptureScope,
  type ConsentCaptureTextEntry,
} from './types';

// PO RULING "Consent Capture" — the ONE reusable recruiter-driven consent-capture
// surface. Consumed by (a) the Add-Talent post-create step and (b) the Talent-360
// Contactability "Record consent" action. It never composes legal text: the exact
// versioned statement is fetched from the server (the D7 hash preimage) per the
// chosen "Captured from" method, and recorded through the authoritative capture
// seam. Failure is surfaced explicitly — a failed persistence never reads as a
// successful selection.

const SCOPE_LABELS: Record<ConsentCaptureScope, string> = {
  profile_storage: 'Store and maintain this Talent profile',
  matching: 'Use this profile for job matching',
  contacting: 'Contact this Talent regarding recruiting opportunities',
};

const METHOD_OPTIONS: ReadonlyArray<RadioOption<ConsentCaptureMethod>> = [
  { value: 'self_signup', label: 'Talent directly' },
  { value: 'recruiter_capture', label: "Recruiter records the Talent's authorization" },
];

export interface RecordConsentDialogProps {
  talentRecordId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Invalidation hook — the parent re-fetches contactability after a grant.
  onRecorded?: () => void;
}

export function RecordConsentDialog({
  talentRecordId,
  open,
  onOpenChange,
  onRecorded,
}: RecordConsentDialogProps) {
  const toast = useToast();
  const [method, setMethod] = useState<ConsentCaptureMethod>('recruiter_capture');
  const [selected, setSelected] = useState<Record<ConsentCaptureScope, boolean>>({
    profile_storage: true,
    matching: true,
    contacting: true,
  });
  const [texts, setTexts] = useState<ConsentCaptureTextEntry[] | null>(null);
  const [textsVersion, setTextsVersion] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the EXACT versioned consent statement for the chosen method. The
  // displayed bytes are the hash preimage — rendered server-side, never here.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTexts(null);
    setError(null);
    getConsentCaptureTexts(method)
      .then((res) => {
        if (cancelled) return;
        setTexts(res.texts);
        setTextsVersion(res.version);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the consent statement. Please try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, method]);

  // Dependency closure in the UI (profile_storage -> matching -> contacting): a
  // logically invalid combination can never be submitted. Enabling a scope turns
  // on its prerequisites; disabling a prerequisite turns off its dependents.
  function toggle(scope: ConsentCaptureScope, on: boolean): void {
    setSelected((prev) => {
      const next = { ...prev, [scope]: on };
      if (on) {
        if (scope === 'contacting') {
          next.matching = true;
          next.profile_storage = true;
        }
        if (scope === 'matching') next.profile_storage = true;
      } else {
        if (scope === 'profile_storage') {
          next.matching = false;
          next.contacting = false;
        }
        if (scope === 'matching') next.contacting = false;
      }
      return next;
    });
  }

  const chosenScopes = CONSENT_CAPTURE_SCOPES.filter((s) => selected[s]);
  const canSubmit = chosenScopes.length > 0 && texts !== null && !submitting;

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await captureConsent({
        talent_record_id: talentRecordId,
        captured_method: method,
        scopes: chosenScopes,
      });
      toast.show('Consent recorded');
      onRecorded?.();
      onOpenChange(false);
    } catch {
      // Explicit failure — never present a failed persistence as success.
      setError('Consent could not be recorded. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
      title="Record consent"
      description="Record the Talent's recruiting-contact consent. Nothing is contacted until consent is on file."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? 'Recording…' : 'Record consent'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="rc-field">
          <div className="rc-field__label">Recruiting contact consent</div>
          {CONSENT_CAPTURE_SCOPES.map((scope) => (
            <label key={scope} className="rc-check">
              <Checkbox
                checked={selected[scope]}
                onChange={(e) => toggle(scope, e.target.checked)}
                disabled={submitting}
              />
              <span>{SCOPE_LABELS[scope]}</span>
            </label>
          ))}
        </div>

        <div className="rc-field">
          <div className="rc-field__label">Captured from</div>
          <RadioGroup<ConsentCaptureMethod>
            name="rc-captured-method"
            value={method}
            options={METHOD_OPTIONS}
            onValueChange={setMethod}
            disabled={submitting}
          />
        </div>

        <div className="rc-field">
          <div className="rc-field__label">
            Consent statement{textsVersion !== '' ? ` (${textsVersion})` : ''}
          </div>
          {texts === null && error === null ? (
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.85rem' }}>
              Loading consent statement…
            </p>
          ) : null}
          {texts !== null ? (
            <div
              style={{
                display: 'grid',
                gap: 8,
                fontSize: '0.85rem',
                color: 'var(--muted)',
                background: 'var(--surface-2, #f6f8fb)',
                border: '1px solid var(--line, #e3e8ef)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              {texts
                .filter((t) => selected[t.scope])
                .map((t) => (
                  <p key={t.scope} style={{ margin: 0 }}>
                    {t.text}
                  </p>
                ))}
            </div>
          ) : null}
        </div>

        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </div>
    </Dialog>
  );
}
