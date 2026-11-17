import { useEffect, useState } from 'react';

import { EndState, Header, base64ToBlobUrl } from './App.js';
import { Btn } from './controls.js';
import { SignApiError, signApi, type RecipientCopy } from './sign-api.js';

// Aramo-Sign-Unified-Product-Amendment-M-A5 §2.2 / UAT CMP-14 — /c/:token: what a
// copy recipient opens from the "For your records" email. The COPY_VIEW token is the
// only authority (no session, no sign-in); the server returns the documents AS SENT —
// no signer data, no recipient list. View opens a document in a new tab; Download saves it.

function tokenFromPath(): string {
  const m = /\/c\/([^/?#]+)/.exec(window.location.pathname);
  return m !== null && m[1] !== undefined ? decodeURIComponent(m[1]) : '';
}

function fileName(title: string): string {
  const base = title.replace(/\.pdf$/i, '').replace(/[^\w .-]+/g, '').trim() || 'document';
  return `${base}.pdf`;
}

type State = { kind: 'loading' } | { kind: 'ready'; copy: RecipientCopy } | { kind: 'invalid' } | { kind: 'expired' } | { kind: 'error' };

export function CopyApp(): JSX.Element {
  const [token] = useState(tokenFromPath);
  const [state, setState] = useState<State>(token.length === 0 ? { kind: 'invalid' } : { kind: 'loading' });

  useEffect(() => {
    if (token.length === 0) return;
    signApi
      .copy(token)
      .then((copy) => setState({ kind: 'ready', copy }))
      .catch((e: unknown) => {
        if (e instanceof SignApiError && e.code === 'SIGNING_SESSION_EXPIRED') setState({ kind: 'expired' });
        else if (e instanceof SignApiError && (e.code === 'SIGNING_SESSION_INVALID' || e.code === 'ENVELOPE_NOT_FOUND')) setState({ kind: 'invalid' });
        else setState({ kind: 'error' });
      });
  }, [token]);

  const view = (b64: string, type: string) => {
    const url = base64ToBlobUrl(b64, type);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const save = (b64: string, type: string, name: string) => {
    const url = base64ToBlobUrl(b64, type);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (state.kind === 'loading')
    return (
      <>
        <Header />
        <main className="sg-center" aria-busy="true">
          <p className="sg-muted">Getting your copy…</p>
        </main>
      </>
    );
  if (state.kind === 'invalid')
    return (
      <>
        <Header />
        <EndState tone="error" title="This link isn't valid" body="Open it again from your email, or ask the sender for a copy." />
      </>
    );
  if (state.kind === 'expired')
    return (
      <>
        <Header />
        <EndState tone="muted" title="This link has expired" body="Copy links work for 30 days. Ask the sender for a copy of the documents." />
      </>
    );
  if (state.kind === 'error')
    return (
      <>
        <Header />
        <EndState tone="error" title="Something went wrong" body="We couldn't get your copy. Try the link from your email again later." />
      </>
    );

  const { copy } = state;
  return (
    <>
      <Header />
      <main className="sg-center">
        <div className="sg-card" data-testid="sg-copy">
          <div className="sg-eyebrow">For your records</div>
          <h1>{copy.subject}</h1>
          {copy.sent_at ? <p className="sg-muted">Sent {new Date(copy.sent_at).toLocaleString()}</p> : null}
          <p className="sg-muted sg-small">You were sent a copy of these documents. You don&apos;t need to sign anything.</p>
          {copy.documents.map((d, i) => (
            <div key={i} className="sg-copydoc" data-testid="sg-copy-doc">
              <strong>{d.title}</strong>
              <span className="sg-copydoc__actions">
                <Btn variant="secondary" onClick={() => view(d.source_base64, d.content_type)}>
                  View
                </Btn>
                <Btn variant="quiet" onClick={() => save(d.source_base64, d.content_type, fileName(d.title))}>
                  Download
                </Btn>
              </span>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
