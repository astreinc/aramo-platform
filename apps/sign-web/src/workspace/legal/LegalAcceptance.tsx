import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Dialog, logout } from '@aramo/fe-foundation';

import { errorMessage, legalApi, type PendingLegalDocument } from '../api';
import { Btn, Check, ErrorBox } from '../ui';

import { footerLegalLinks } from './catalog';

// Aramo Sign Personal (Free) — re-acceptance in the workspace. When the backend
// (GET /v1/sign/legal/status) lists current legal documents this user has not
// accepted, a blocking dialog lists them (title, version, link in a new tab) with
// an unticked checkbox; the user accepts or signs out. The backend decides what is
// pending and refuses sending while anything is (the dialog only renders that). A
// failed status read does not block the page: the send gate still holds.

export function LegalAcceptanceGate({ load = legalApi.status, accept = legalApi.accept }: { load?: typeof legalApi.status; accept?: typeof legalApi.accept }) {
  const [pending, setPending] = useState<PendingLegalDocument[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    load()
      .then((r) => setPending(Array.isArray(r?.pending) ? r.pending : []))
      .catch(() => setPending([]));
  }, [load]);
  useEffect(refresh, [refresh]);

  if (pending.length === 0) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreed) return;
    setBusy(true);
    setError(null);
    accept(pending)
      .then((r) => {
        setAgreed(false);
        setPending(Array.isArray(r?.pending) ? r.pending : []);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err, 'We couldn’t record your acceptance. Try again.'));
        refresh();
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title="Review the updated terms"
      description="Before you send documents, read and accept the current versions of these documents."
    >
      <form className="sg" style={{ minHeight: 0, background: 'transparent' }} onSubmit={submit} data-testid="legal-accept-dialog">
        <ul className="sg-legal-accept__list" data-testid="legal-accept-docs">
          {pending.map((d) => (
            <li key={`${d.key}@${d.version}`}>
              <a href={d.url} target="_blank" rel="noopener noreferrer">
                {d.title}
              </a>{' '}
              <span className="sg-muted">(version {d.version})</span>
            </li>
          ))}
        </ul>
        <label className="sg-settings-row" htmlFor="legal-accept">
          <Check id="legal-accept" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="legal-accept-check" />
          <span>I have read and agree to the documents above.</span>
        </label>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Btn variant="primary" type="submit" disabled={busy || !agreed} data-testid="legal-accept-submit">
            {busy ? 'Saving…' : 'Accept and continue'}
          </Btn>
          <Btn type="button" onClick={() => void logout()}>
            Sign out
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}

/** The workspace footer: the legal documents that bind this account (Business: only those for every account). */
export function LegalLinks({ personal }: { personal: boolean }) {
  return (
    <nav className="sg-legal-links" aria-label="Legal" data-testid="legal-links">
      {footerLegalLinks(personal).map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
          {l.label}
        </a>
      ))}
    </nav>
  );
}
