import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Btn, CheckIn, TextBox, TextIn } from './controls.js';
import { PdfDocument, type FieldDisplay } from './pdf-view.js';
import { SignApiError, signApi, type SignField, type SignerDocumentView } from './sign-api.js';

// The external signer app (sign.aramo.ai/s/:token) — what a recipient sees after
// clicking "Review & sign" in an invitation email (e.g. a talent signing a Right
// to Represent sent from the ATS). Design authority: the accepted "Aramo Sign —
// how the signer app is reached" handoff + "Aramo Sign RTR Signing" storyboard
// (landing · disclosure · workspace · adopt · review · completion · decline ·
// edge states · style sheet 9a); LOCKED E-Sign directives govern.
//
// Rules this app keeps (signer handoff §1/§5):
//  - Reached ONLY through a signing link for one envelope and one recipient.
//  - No main nav, no app switcher, no account menu, no search, no notifications,
//    no organization name, no link back into any Aramo app — before, during or
//    after signing (the recipient may have no Aramo account).
//  - No token / bad token → the Invalid link state, never a sign-in page.
//  - Everything is decided by the signing endpoints (token-authorized, tenant
//    resolved server-side); the client sends no tenant id.

type Screen =
  | 'loading'
  | 'landing'
  | 'disclosure'
  | 'workspace'
  | 'review'
  | 'done'
  | 'declined'
  | 'invalid'
  | 'expired'
  | 'ended'
  | 'network'
  | 'error';

const FIELD_LABEL: Record<string, string> = {
  SIGNATURE: 'Signature',
  INITIALS: 'Initials',
  SIGN_DATE: 'Date signed',
  SIGNER_NAME: 'Your full name',
  TEXT: 'Text',
  CHECKBOX: 'Checkbox',
  ACKNOWLEDGEMENT: 'Acknowledgement',
};
const ACTION_LABEL: Record<string, string> = {
  SIGNATURE: 'Sign',
  INITIALS: 'Initial',
  SIGN_DATE: 'Add date',
  SIGNER_NAME: 'Enter name',
  TEXT: 'Enter text',
  CHECKBOX: 'Check',
  ACKNOWLEDGEMENT: 'Acknowledge',
};

function tokenFromLocation(): string {
  const m = /\/s\/([^/?#]+)/.exec(window.location.pathname);
  if (m !== null && m[1] !== undefined) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 3);
}

function screenForError(e: unknown): Screen {
  if (e instanceof SignApiError) {
    if (e.code === 'SIGNING_SESSION_INVALID') return 'invalid';
    if (e.code === 'SIGNING_SESSION_EXPIRED') return 'expired';
    if (e.code === 'ENVELOPE_ALREADY_EXECUTED') return 'ended';
    if (e.code === 'NETWORK') return 'network';
  }
  return 'error';
}

interface Adopted {
  readonly method: 'TYPED' | 'DRAWN';
  readonly value: string;
  readonly display: string;
}

// A field filled in an earlier visit (value not returned by the server).
const FILLED_MARK = '\u2713';

function base64ToBlobUrl(b64: string, type: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// ── Header: brand + security note; in the workspace also the subject, progress,
// Help and Decline. Never any navigation into an Aramo app. ──
function Header({
  title,
  progress,
  onDecline,
}: {
  readonly title?: string;
  readonly progress?: string;
  readonly onDecline?: () => void;
}) {
  const [help, setHelp] = useState(false);
  return (
    <header className="sg-head">
      <span className="sg-mark" aria-hidden="true">
        S
      </span>
      <span className="sg-head__text">
        <span className="sg-head__title">{title ?? 'Aramo Sign'}</span>
        <span className="sg-head__sub">
          <LockIcon /> Secured by Aramo Sign{progress ? ` · ${progress}` : ''}
        </span>
      </span>
      <span className="sg-head__grow" />
      <Btn variant="quiet" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        Help
      </Btn>
      {onDecline ? (
        <Btn variant="quiet" onClick={onDecline}>
          Decline to sign
        </Btn>
      ) : null}
      {help ? (
        <div className="sg-help" role="note">
          Questions about this document? Reply to the email that brought you here, or contact the person who sent
          it. Your signing link is personal — don&apos;t forward it.
        </div>
      ) : null}
    </header>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

// ── Dialog (modal; Esc closes; focus stays inside) ──
function Dialog({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const focusables = () =>
      el ? [...el.querySelectorAll<HTMLElement>('button, input, textarea, canvas[tabindex]')].filter((n) => !n.hasAttribute('disabled')) : [];
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (first === undefined || last === undefined) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sg-scrim">
      <div className="sg-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ── Adopt your signature: Type or Draw ──
function AdoptDialog({
  kind,
  suggestedName,
  onAdopt,
  onClose,
}: {
  readonly kind: 'SIGNATURE' | 'INITIALS';
  readonly suggestedName: string;
  readonly onAdopt: (a: Adopted) => void;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<'TYPED' | 'DRAWN'>('TYPED');
  const [typed, setTyped] = useState(kind === 'INITIALS' ? initialsOf(suggestedName) : suggestedName);
  const [drawn, setDrawn] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const label = kind === 'INITIALS' ? 'initials' : 'signature';

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (c === null) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#151A22';
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setDrawn(true);
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };

  const ready = tab === 'TYPED' ? typed.trim().length > 0 : drawn;
  const adopt = () => {
    if (tab === 'TYPED') onAdopt({ method: 'TYPED', value: typed.trim(), display: typed.trim() });
    else onAdopt({ method: 'DRAWN', value: canvasRef.current?.toDataURL('image/png') ?? '', display: 'Drawn' });
  };

  return (
    <Dialog title={kind === 'INITIALS' ? 'Adopt your initials' : 'Adopt your signature'} onClose={onClose}>
      <div className="sg-tabs" role="tablist" aria-label={`How to create your ${label}`}>
        <Btn variant="quiet" role="tab" aria-selected={tab === 'TYPED'} className={tab === 'TYPED' ? 'sg-tab--on' : ''} onClick={() => setTab('TYPED')}>
          Type
        </Btn>
        <Btn variant="quiet" role="tab" aria-selected={tab === 'DRAWN'} className={tab === 'DRAWN' ? 'sg-tab--on' : ''} onClick={() => setTab('DRAWN')}>
          Draw
        </Btn>
      </div>
      {tab === 'TYPED' ? (
        <>
          <label className="sg-label">
            {kind === 'INITIALS' ? 'Your initials' : 'Your full name'}
            <TextIn value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={kind === 'INITIALS' ? 'Your initials' : 'Your full name'} />
          </label>
          <div className="sg-preview" aria-label={`${label} preview`}>
            {typed.trim() || <span className="sg-muted">Preview</span>}
          </div>
        </>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            width={560}
            height={160}
            className="sg-pad"
            tabIndex={0}
            aria-label={`Draw your ${label}`}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
          />
          <p className="sg-muted sg-small">Drawing has no keyboard equivalent — use Type instead if you prefer.</p>
          <Btn variant="quiet" onClick={clear}>
            Clear
          </Btn>
        </>
      )}
      <p className="sg-muted sg-small">
        By selecting Adopt, you agree this mark is your electronic {label} for this document.
      </p>
      <div className="sg-dialog__foot">
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn disabled={!ready} onClick={adopt}>
          {kind === 'INITIALS' ? 'Adopt & initial' : 'Adopt & sign'}
        </Btn>
      </div>
    </Dialog>
  );
}

function TextDialog({
  title,
  initial,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly initial: string;
  readonly onSave: (v: string) => void;
  readonly onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <Dialog title={title} onClose={onClose}>
      <TextIn value={v} onChange={(e) => setV(e.target.value)} aria-label={title} />
      <div className="sg-dialog__foot">
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn disabled={v.trim().length === 0} onClick={() => onSave(v.trim())}>
          Apply
        </Btn>
      </div>
    </Dialog>
  );
}

function DeclineDialog({ onDecline, onClose }: { readonly onDecline: (reason: string) => Promise<void>; readonly onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Decline to sign?" onClose={onClose}>
      <p className="sg-muted">
        The sender will be told you declined, with your reason. You won&apos;t be able to sign this document with this link
        afterwards.
      </p>
      <label className="sg-label">
        Reason (required)
        <TextBox value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-label="Reason for declining" />
      </label>
      <div className="sg-dialog__foot">
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          variant="danger"
          disabled={reason.trim().length === 0 || busy}
          onClick={() => {
            setBusy(true);
            void onDecline(reason.trim()).finally(() => setBusy(false));
          }}
        >
          Decline
        </Btn>
      </div>
    </Dialog>
  );
}

// ── End-state screens: plain language, no link into any Aramo app ──
function EndState({ tone, title, body }: { readonly tone: 'ok' | 'muted' | 'error'; readonly title: string; readonly body: string }) {
  return (
    <main className="sg-center" data-testid="sg-end-state">
      <div className={`sg-card sg-card--${tone}`}>
        <h1>{title}</h1>
        <p>{body}</p>
        <p className="sg-muted sg-small">You can close this page.</p>
      </div>
    </main>
  );
}

export function App(): JSX.Element {
  const [token] = useState<string>(tokenFromLocation);
  const [screen, setScreen] = useState<Screen>(token.length === 0 ? 'invalid' : 'loading');
  const [view, setView] = useState<SignerDocumentView | null>(null);
  const [docUrls, setDocUrls] = useState<Record<string, string>>({});
  // PX-2 — the source bytes (base64) per document, rendered page by page with the
  // signer's fields in place; the browser PDF viewer is only the fallback.
  const [docB64, setDocB64] = useState<Record<string, string>>({});
  const [renderFailed, setRenderFailed] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [filled, setFilled] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [adopted, setAdopted] = useState<{ SIGNATURE?: Adopted; INITIALS?: Adopted }>({});
  const [adoptFor, setAdoptFor] = useState<SignField | null>(null);
  const [textFor, setTextFor] = useState<SignField | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [finishError, setFinishError] = useState(false);
  const [allSigned, setAllSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeField, setActiveField] = useState<string | null>(null);

  const fail = useCallback((e: unknown) => setScreen(screenForError(e)), []);
  const onRenderError = useCallback(() => setRenderFailed(true), []);

  const open = useCallback(() => {
    if (token.length === 0) return;
    setScreen('loading');
    signApi
      .exchange(token)
      .then(() => setScreen('landing'))
      .catch(fail);
  }, [token, fail]);

  useEffect(() => {
    open();
  }, [open]);

  useEffect(
    () => () => {
      for (const u of Object.values(docUrls)) URL.revokeObjectURL(u);
    },
    [docUrls],
  );

  const loadWorkspace = async () => {
    const v = await signApi.documentView(token);
    const urls: Record<string, string> = {};
    const b64: Record<string, string> = {};
    for (const d of v.documents) {
      try {
        const src = await signApi.source(token, d.document_id);
        urls[d.document_id] = base64ToBlobUrl(src.source_base64, src.content_type);
        b64[d.document_id] = src.source_base64;
      } catch (e) {
        if (e instanceof SignApiError && e.code !== 'NETWORK') throw e;
        // A document that fails to load shows its own message in the viewer.
      }
    }
    setView(v);
    setDocUrls(urls);
    setDocB64(b64);
    // Restore progress after a reload: the backend returns this signer's own
    // entries, so the page shows the actual signature / date / text in place.
    setFilled((m) => {
      const next = { ...m };
      for (const f of v.fields) {
        if (f.filled === true && next[f.field_id] === undefined) next[f.field_id] = typeof f.value === 'string' && f.value.length > 0 ? f.value : FILLED_MARK;
      }
      return next;
    });
    setActiveDoc(v.documents.slice().sort((a, b) => a.ordinal - b.ordinal)[0]?.document_id ?? null);
    setScreen('workspace');
  };

  const acceptAndContinue = async () => {
    setBusy(true);
    try {
      await signApi.acceptDisclosure(token);
      await loadWorkspace();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const fields = useMemo(() => view?.fields ?? [], [view]);
  const required = fields.filter((f) => f.required);
  const doneRequired = required.filter((f) => filled[f.field_id] !== undefined).length;
  const progress = `${doneRequired} of ${required.length} required fields filled`;
  const nextField = fields.find((f) => f.required && filled[f.field_id] === undefined) ?? fields.find((f) => filled[f.field_id] === undefined) ?? null;
  const title = view?.documents.slice().sort((a, b) => a.ordinal - b.ordinal)[0]?.title;

  const fill = async (f: SignField, value: string, method?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await signApi.fillField(token, f.field_id, value, method);
      setFilled((m) => ({ ...m, [f.field_id]: value }));
    } catch (e) {
      const s = screenForError(e);
      if (s === 'error' || s === 'network') setNotice("That didn't save. Check your connection and try again — your other entries are kept.");
      else setScreen(s);
    } finally {
      setBusy(false);
    }
  };

  // Every field stays editable until Finish signing (the backend accepts a new
  // value while the session is live): a filled signature / initials reopens the
  // adopt dialog to change it, a filled text field reopens its editor.
  const act = (f: SignField) => {
    setActiveField(f.field_id);
    if (f.document_id !== activeDoc) setActiveDoc(f.document_id);
    const t = f.field_type;
    const done = filled[f.field_id] !== undefined;
    if (t === 'SIGNATURE' || t === 'INITIALS') {
      const a = adopted[t];
      if (a && !done) void fill(f, a.value, a.method);
      else setAdoptFor(f);
    } else if (t === 'SIGN_DATE') {
      if (!done) void fill(f, today());
    } else if (t === 'CHECKBOX' || t === 'ACKNOWLEDGEMENT') {
      if (!done) void fill(f, 'true');
    } else setTextFor(f);
  };
  const editable = (f: SignField): boolean => f.field_type !== 'SIGN_DATE' && f.field_type !== 'CHECKBOX' && f.field_type !== 'ACKNOWLEDGEMENT';
  // The typed text already in a field (never a drawn image or a restored mark).
  const typedIn = (f: SignField | null): string => {
    const v = f === null ? undefined : filled[f.field_id];
    return v !== undefined && !v.startsWith('data:image/') && v !== FILLED_MARK ? v : '';
  };

  const finish = async () => {
    setBusy(true);
    setFinishError(false);
    try {
      const r = await signApi.complete(token);
      setAllSigned(r.envelope_status === 'COMPLETED');
      setScreen('done');
    } catch (e) {
      if (e instanceof SignApiError && e.code === 'SIGNATURE_FIELD_INCOMPLETE') {
        setScreen('workspace');
        setNotice('Some required fields still need your input.');
      } else {
        const s = screenForError(e);
        if (s === 'error' || s === 'network') setFinishError(true);
        else setScreen(s);
      }
    } finally {
      setBusy(false);
    }
  };

  const decline = async (reason: string) => {
    try {
      await signApi.decline(token, reason);
      setDeclineOpen(false);
      setScreen('declined');
    } catch (e) {
      setDeclineOpen(false);
      setScreen(screenForError(e));
    }
  };

  const suggestedName = adopted.SIGNATURE?.method === 'TYPED' ? adopted.SIGNATURE.display : '';

  // What a filled field shows on the page: the drawn image, the typed / entered
  // text, or a completed mark (restored from an earlier visit).
  const displayOf = (f: SignField): FieldDisplay | null => {
    const v = filled[f.field_id];
    if (v === undefined) return null;
    if (v.startsWith('data:image/')) return { kind: 'image', value: v };
    if (f.field_type === 'CHECKBOX' || f.field_type === 'ACKNOWLEDGEMENT' || v === FILLED_MARK) return { kind: 'mark', value: FILLED_MARK };
    return { kind: 'text', value: v };
  };

  // ── End states ──
  if (screen === 'invalid')
    return (
      <>
        <Header />
        <EndState tone="error" title="This signing link isn't valid" body="The link may be incomplete or mistyped. Open it again from your email, or ask the sender to send a new one." />
      </>
    );
  if (screen === 'expired')
    return (
      <>
        <Header />
        <EndState tone="muted" title="This link is no longer active" body="It has expired or has already been used to sign. If you still need to sign, ask the sender to send you a new link." />
      </>
    );
  if (screen === 'ended')
    return (
      <>
        <Header />
        <EndState tone="muted" title="This document is no longer available to sign" body="Signing has ended for this document — it may have been completed, declined or withdrawn by the sender." />
      </>
    );
  if (screen === 'declined')
    return (
      <>
        <Header />
        <EndState tone="muted" title="You declined to sign" body="The sender has been told, with your reason." />
      </>
    );
  if (screen === 'done')
    return (
      <>
        <Header />
        <EndState
          tone="ok"
          title={title ? `You've signed ${title}` : "You've signed"}
          body={allSigned ? 'Everyone has signed. The sender has been notified.' : "Your part is done. Others still need to sign; the sender will be notified when everyone has."}
        />
      </>
    );
  if (screen === 'network')
    return (
      <>
        <Header />
        <main className="sg-center">
          <div className="sg-card sg-card--error">
            <h1>We couldn&apos;t reach Aramo Sign</h1>
            <p>Check your internet connection and try again.</p>
            <Btn onClick={open}>Try again</Btn>
          </div>
        </main>
      </>
    );
  if (screen === 'error')
    return (
      <>
        <Header />
        <EndState tone="error" title="Something went wrong" body="We couldn't open this document. Try the link from your email again later, or contact the sender." />
      </>
    );
  if (screen === 'loading')
    return (
      <>
        <Header />
        <main className="sg-center" aria-busy="true">
          <p className="sg-muted">Opening your document…</p>
        </main>
      </>
    );

  if (screen === 'landing')
    return (
      <>
        <Header />
        <main className="sg-center">
          <div className="sg-card" data-testid="sg-landing">
            <div className="sg-eyebrow">Document to sign</div>
            <h1>You&apos;ve been asked to review and sign a document</h1>
            <p className="sg-muted">Signing with a secure link — no account needed.</p>
            <Btn className="sg-btn--block" onClick={() => setScreen('disclosure')}>
              Review document
            </Btn>
            <Btn variant="quiet" className="sg-btn--block" onClick={() => setDeclineOpen(true)}>
              Decline to sign
            </Btn>
          </div>
        </main>
        {declineOpen ? <DeclineDialog onDecline={decline} onClose={() => setDeclineOpen(false)} /> : null}
      </>
    );

  if (screen === 'disclosure')
    return (
      <>
        <Header />
        <main className="sg-center">
          <div className="sg-card sg-card--wide" data-testid="sg-disclosure">
            <h1>Before you sign electronically</h1>
            <div className="sg-disclosure" tabIndex={0} aria-label="Electronic records and signature disclosure">
              <h2>Electronic records and signature disclosure</h2>
              <p>By continuing you consent to sign this document electronically.</p>
              <p className="sg-muted sg-small">Version {'v1'}</p>
            </div>
            <label className="sg-agree">
              <CheckIn checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I agree to use electronic records and signatures.</span>
            </label>
            <Btn className="sg-btn--block" disabled={!consent || busy} onClick={() => void acceptAndContinue()}>
              Agree &amp; continue
            </Btn>
          </div>
        </main>
      </>
    );

  // ── Workspace / Review ──
  const docs = (view?.documents ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
  const doc = docs.find((d) => d.document_id === activeDoc) ?? docs[0];
  const url = doc ? docUrls[doc.document_id] : undefined;
  const allDone = required.length === doneRequired;

  return (
    <>
      <Header title={title} progress={progress} onDecline={() => setDeclineOpen(true)} />
      {screen === 'review' ? (
        <main className="sg-center">
          <div className="sg-card sg-card--wide" data-testid="sg-review">
            <h1>Review &amp; finish</h1>
            <ul className="sg-summary">
              {fields.map((f) => (
                <li key={f.field_id}>
                  <span>
                    {FIELD_LABEL[f.field_type] ?? f.field_type} · page {f.page_number + 1}
                  </span>
                  <span className={filled[f.field_id] !== undefined ? 'sg-ok' : 'sg-muted'}>
                    {filled[f.field_id] !== undefined ? 'Filled' : f.required ? 'Required' : 'Optional · skipped'}
                  </span>
                </li>
              ))}
            </ul>
            {finishError ? (
              <p className="sg-error" role="alert">
                Finishing didn&apos;t go through. Your entries are kept — try again.
              </p>
            ) : null}
            <div className="sg-dialog__foot">
              <Btn variant="secondary" onClick={() => setScreen('workspace')}>
                Back to document
              </Btn>
              <Btn disabled={busy || !allDone} onClick={() => void finish()}>
                {busy ? 'Finishing…' : finishError ? 'Try again' : 'Finish signing'}
              </Btn>
            </div>
          </div>
        </main>
      ) : (
        <main className="sg-work" data-testid="sg-workspace">
          <section className="sg-viewer" aria-label="Document">
            {docs.length > 1 ? (
              <div className="sg-doctabs">
                {docs.map((d) => (
                  <Btn key={d.document_id} variant="quiet" className={d.document_id === doc?.document_id ? 'sg-tab--on' : ''} onClick={() => setActiveDoc(d.document_id)}>
                    {d.title}
                  </Btn>
                ))}
              </div>
            ) : null}
            {doc && docB64[doc.document_id] !== undefined && !renderFailed ? (
              <PdfDocument
                base64={docB64[doc.document_id] ?? ''}
                fields={fields.filter((f) => f.document_id === doc.document_id)}
                display={displayOf}
                activeField={activeField}
                label={(f) => FIELD_LABEL[f.field_type] ?? f.field_type}
                actionLabel={(f) => ACTION_LABEL[f.field_type] ?? 'Complete'}
                onField={(f) => {
                  if (!busy) act(f);
                }}
                onError={onRenderError}
              />
            ) : url ? (
              <iframe className="sg-frame" title={doc?.title ?? 'Document'} src={url} />
            ) : (
              <div className="sg-frame sg-frame--missing" role="status">
                This document couldn&apos;t be displayed. You can still complete your fields; contact the sender if you need
                a copy.
              </div>
            )}
          </section>
          <aside className="sg-fields" aria-label="Your fields">
            <h2>Your fields</h2>
            <p className="sg-muted sg-small" aria-live="polite">
              {progress}
            </p>
            {notice ? (
              <p className="sg-error" role="alert">
                {notice}
              </p>
            ) : null}
            <ul>
              {fields.map((f) => {
                const done = filled[f.field_id] !== undefined;
                return (
                  <li key={f.field_id} className={`sg-field${done ? ' sg-field--done' : ''}${activeField === f.field_id ? ' sg-field--active' : ''}`}>
                    <span className="sg-field__text">
                      <span className="sg-field__name">{FIELD_LABEL[f.field_type] ?? f.field_type}</span>
                      <span className="sg-field__meta">
                        {docs.length > 1 ? `${docs.find((d) => d.document_id === f.document_id)?.title ?? ''} · ` : ''}page {f.page_number + 1}
                        {f.required ? ' · required' : ' · optional'}
                      </span>
                    </span>
                    {done ? (
                      <span className="sg-done-actions">
                        <span className="sg-ok">Filled</span>
                        {editable(f) ? (
                          <Btn variant="quiet" disabled={busy} onClick={() => act(f)} aria-label={`Change ${FIELD_LABEL[f.field_type] ?? f.field_type}, page ${f.page_number + 1}`}>
                            Change
                          </Btn>
                        ) : null}
                      </span>
                    ) : (
                      <Btn variant={f.required ? 'primary' : 'secondary'} disabled={busy} onClick={() => act(f)} aria-label={`${ACTION_LABEL[f.field_type] ?? 'Complete'}: ${FIELD_LABEL[f.field_type] ?? f.field_type}, page ${f.page_number + 1}`}>
                        {ACTION_LABEL[f.field_type] ?? 'Complete'}
                      </Btn>
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>
          <div className="sg-bar">
            <div className="sg-progress" aria-hidden="true">
              <span style={{ width: `${required.length === 0 ? 100 : Math.round((doneRequired / required.length) * 100)}%` }} />
            </div>
            <span className="sg-small">{progress}</span>
            {allDone ? (
              <Btn onClick={() => setScreen('review')}>Review &amp; finish</Btn>
            ) : (
              <Btn disabled={busy || nextField === null} onClick={() => nextField && act(nextField)}>
                {doneRequired === 0 ? 'Start' : 'Next field'}
              </Btn>
            )}
          </div>
        </main>
      )}
      {adoptFor ? (
        <AdoptDialog
          kind={adoptFor.field_type === 'INITIALS' ? 'INITIALS' : 'SIGNATURE'}
          suggestedName={typedIn(adoptFor) !== '' ? typedIn(adoptFor) : suggestedName}
          onClose={() => setAdoptFor(null)}
          onAdopt={(a) => {
            const f = adoptFor;
            const kind = f.field_type === 'INITIALS' ? 'INITIALS' : 'SIGNATURE';
            setAdopted((m) => ({ ...m, [kind]: a }));
            setAdoptFor(null);
            void fill(f, a.value, a.method);
          }}
        />
      ) : null}
      {textFor ? (
        <TextDialog
          title={FIELD_LABEL[textFor.field_type] ?? 'Text'}
          initial={typedIn(textFor) !== '' ? typedIn(textFor) : textFor.field_type === 'SIGNER_NAME' ? suggestedName : ''}
          onClose={() => setTextFor(null)}
          onSave={(v) => {
            const f = textFor;
            setTextFor(null);
            void fill(f, v);
          }}
        />
      ) : null}
      {declineOpen ? <DeclineDialog onDecline={decline} onClose={() => setDeclineOpen(false)} /> : null}
    </>
  );
}
