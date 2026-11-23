import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DELEGATE_REASON_MAX,
  SIGN_DATE_PREVIEW_NOTE,
  dateBoundsOf,
  dropdownChoicesOf,
  fieldInputHint,
  fieldInputLimit,
  fieldValueDisplay,
  fieldValueRefusalText,
  formatChosenDate,
  isFieldValueRefusalReason,
  isIsoDate,
  isValidDeclineReason,
  isValidDelegate,
  normalizeSignerInput,
  numberPrefixOf,
  radioChoiceClearable,
  signDatePreview,
  signerFieldCaption,
  signerFieldTooltip,
  signerFieldPlaceholder,
  signerInputKind,
  signerValueProblem,
} from '@aramo/sign-client';

import { stashInboxClaim } from '../inbox-claim-handoff';
import { trimmedSignaturePng, typedSignaturePng } from '../signature-image';

import { Btn, CheckIn, SelectIn, TextBox, TextIn } from './controls.js';
import { PdfDocument, type FieldDisplay } from './pdf-view.js';
import { SAVED_MARK_FONT_KEY, SignApiError, signApi, type GuestSavedMark, type GuestSavedMarks, type QesStatus, type SignField, type SignerBranding, type SignerDisclosure, type SignerDocumentView } from './sign-api.js';
import {
  FILLED_MARK,
  awaitsSigner,
  completionProblem,
  formatAmount,
  incompleteMessage,
  isBox,
  isChecked,
  isLocked,
  isPayment,
  isRadio,
  isServerName,
  nextFieldToDo,
  requirements,
  selectOneSiblings,
  shownSignFields,
  withoutHiddenAnswers,
} from './field-rules.js';

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
  | 'notyet'
  | 'accesscode'
  | 'locked'
  | 'identity'
  | 'idlocked'
  | 'smscode'
  | 'smslocked'
  | 'delegated'
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
  PAYMENT: 'Payment',
  // M-A12 W1-C.4 — profile text fields (the signer enters them).
  FIRST_NAME: 'First name',
  LAST_NAME: 'Last name',
  EMAIL: 'Email',
  COMPANY: 'Company',
  TITLE: 'Title',
  // FIELD-PARITY-1 P3 T-3..T-7 — the new types (a field's label setting names it first).
  DATE: 'Date',
  DROPDOWN: 'Choice',
  RADIO: 'Option',
  NUMBER: 'Number',
  MULTILINE_TEXT: 'Text',
};
const ACTION_LABEL: Record<string, string> = {
  SIGNATURE: 'Sign',
  INITIALS: 'Initial',
  SIGN_DATE: 'Add date',
  SIGNER_NAME: 'Enter name',
  TEXT: 'Enter text',
  CHECKBOX: 'Check',
  ACKNOWLEDGEMENT: 'Acknowledge',
  PAYMENT: 'Pay',
  FIRST_NAME: 'Enter first name',
  LAST_NAME: 'Enter last name',
  EMAIL: 'Enter email',
  COMPANY: 'Enter company',
  TITLE: 'Enter title',
  DATE: 'Choose date',
  DROPDOWN: 'Choose',
  RADIO: 'Choose',
  NUMBER: 'Enter number',
  MULTILINE_TEXT: 'Enter text',
};

// M-A6 — a check box shows its caption; a server-filled name says where it is from.
// FIELD-PARITY-1 P3 S-1 — any field's label setting is its caption and accessible name (a
// radio button's label is its option's text).
export function fieldLabel(f: SignField): string {
  if (isServerName(f)) return 'Your name';
  return signerFieldCaption(f) ?? FIELD_LABEL[f.field_type] ?? f.field_type;
}

/**
 * Amendment M-A7 §5.2 (R-11) — the guest page's Report action: the same
 * "Report this email" page the email links to, with the signing token in the URL
 * FRAGMENT only (never a query string or a path, so no request line or server
 * log carries it). Null without a usable token.
 */
export function reportHrefForToken(token: string): string | null {
  return /^[A-Za-z0-9_-]{16,256}$/.test(token) ? `/report#token=${encodeURIComponent(token)}` : null;
}

function ReportLink({ token, className }: { readonly token?: string; readonly className?: string }) {
  const href = token === undefined ? null : reportHrefForToken(token);
  if (href === null) return null;
  return (
    <a href={href} rel="noreferrer" className={className} data-testid="sg-report">
      Report this document
    </a>
  );
}

// Sign 1.14 — Stripe returns the payer to /s/payment-return?field=…&payment=success|cancel.
// The signing token never goes to Stripe: it is kept in this tab while the payer is away.
const PAYMENT_RETURN_PATH = '/s/payment-return';
const PAYMENT_TOKEN_KEY = 'aramo-sign-payment-token';
// FIELD-PARITY-1 P3 — the page's words for a field save and the sender's values.
const SAVE_FAILED = "That didn't save. Check your connection and try again — your other entries are kept.";
export const SENDER_VALUE = 'Filled in by the sender';
// A chosen radio option on the page (the executed PDF draws a filled circle).
const RADIO_MARK = '●';
const NOTICE_FOCUS = 'notice';

function paymentReturn(): { field_id: string } | null {
  if (window.location.pathname !== PAYMENT_RETURN_PATH) return null;
  const field_id = new URLSearchParams(window.location.search).get('field');
  return field_id !== null && field_id.length > 0 ? { field_id } : null;
}

function storedPaymentToken(): string {
  return storedToken(PAYMENT_TOKEN_KEY);
}

function storedToken(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

// Consolidated Directive B3 (Feature-Parity §1.16) — the trust service provider returns the
// signer to /qes/callback?code=…&state=… (the redirect URI sign-service registers). The
// signing token never goes to the provider: it is kept in this tab while the signer is away,
// and the signer comes back to the document at /s/qes-return.
export const QES_CALLBACK_PATH = '/qes/callback';
const QES_RETURN_PATH = '/s/qes-return';
const QES_TOKEN_KEY = 'aramo-sign-qes-token';

function tokenFromLocation(): string {
  if (window.location.pathname === PAYMENT_RETURN_PATH) return storedPaymentToken();
  if (window.location.pathname === QES_RETURN_PATH || window.location.pathname === QES_CALLBACK_PATH) return storedToken(QES_TOKEN_KEY);
  const m = /\/s\/([^/?#]+)/.exec(window.location.pathname);
  if (m !== null && m[1] !== undefined) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get('token') ?? '';
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
    // Multi-Signer §4 — signing in order: an earlier signer has not signed yet.
    if (e.code === 'SIGNER_NOT_YET_ELIGIBLE') return 'notyet';
    // Feature-Parity §1.9 — the sender set an access code for this recipient.
    if (e.code === 'SIGNER_ACCESS_CODE_REQUIRED') return 'accesscode';
    if (e.code === 'SIGNER_ACCESS_CODE_LOCKED') return 'locked';
    // Feature-Parity §1.9 — the sender asked this recipient to verify their identity.
    if (e.code === 'SIGNER_IDENTITY_VERIFICATION_REQUIRED') return 'identity';
    if (e.code === 'SIGNER_IDENTITY_VERIFICATION_LOCKED') return 'idlocked';
    // Feature-Parity §1.9 — the sender asked for a code sent by SMS before the document opens.
    if (e.reason === 'recipient_verification_required') return 'smscode';
    if (e.reason === 'recipient_verification_locked' || e.reason === 'otp_locked') return 'smslocked';
    if (e.code === 'NETWORK') return 'network';
  }
  return 'error';
}

interface Adopted {
  readonly method: 'TYPED' | 'DRAWN';
  readonly value: string;
  readonly display: string;
}

// M-A15 §6 — a saved mark as the value the fill call sends: a TYPED mark sends its text
// (initials derived from the stored name, as the app does), a DRAWN mark its image.
export function adoptedFromSaved(saved: GuestSavedMark, kind: 'SIGNATURE' | 'INITIALS'): Adopted {
  if (saved.kind === 'TYPED' && saved.typed_name !== null && saved.typed_name.trim() !== '') {
    const text = kind === 'INITIALS' ? initialsOf(saved.typed_name) : saved.typed_name.trim();
    return { method: 'TYPED', value: text, display: text };
  }
  return { method: 'DRAWN', value: saved.image_data_url, display: 'Drawn' };
}

// M-A15 §4.2 — the stored typed_name. The app stores the full name and derives initials
// from it; this page types initials directly, so they are stored letter by letter
// ("RS" → "R S"), which every client derives back to "RS".
export function typedNameToStore(kind: 'SIGNATURE' | 'INITIALS', text: string): string {
  const t = text.trim().slice(0, 100);
  return kind === 'INITIALS' ? t.replace(/\s+/g, '').split('').join(' ').slice(0, 100) : t;
}


// A drawn signature is saved CROPPED to its ink (plus a small margin) so it fills
// the field box the sender sized (shared helper: ../signature-image).

export function base64ToBlobUrl(b64: string, type: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// ── Branding (Feature-Parity §1.10): the sending organization's logo, colours and name, or
// the Aramo Sign look (null). Fetched once per page; any failure keeps the default look. ──
const SignerBrandingContext = createContext<SignerBranding | null>(null);

const HEX = /^#[0-9A-Fa-f]{6}$/;
const SAME_ORIGIN_LOGO = /^\/v1\/sign\/signing\/brand-logo\/[0-9a-fA-F-]{36}$/;

/** The branding to apply: only well-formed colours and a same-origin logo path survive. */
export function safeBranding(b: SignerBranding | null | undefined): SignerBranding | null {
  if (b == null) return null;
  return {
    display_name: typeof b.display_name === 'string' && b.display_name.trim() !== '' ? b.display_name.trim() : null,
    primary_color: typeof b.primary_color === 'string' && HEX.test(b.primary_color) ? b.primary_color : null,
    accent_color: typeof b.accent_color === 'string' && HEX.test(b.accent_color) ? b.accent_color : null,
    logo_url: typeof b.logo_url === 'string' && SAME_ORIGIN_LOGO.test(b.logo_url) ? b.logo_url : null,
  };
}

function useSignerBranding(token: string): SignerBranding | null {
  const [branding, setBranding] = useState<SignerBranding | null>(null);
  useEffect(() => {
    if (token.length === 0) return;
    let live = true;
    signApi
      .branding(token)
      .then((b) => {
        if (live) setBranding(safeBranding(b));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token]);
  useEffect(() => {
    const root = document.documentElement.style;
    if (branding?.primary_color == null) return;
    root.setProperty('--sg-accent', branding.primary_color);
    root.setProperty('--sg-accent-hover', branding.accent_color ?? branding.primary_color);
    return () => {
      root.removeProperty('--sg-accent');
      root.removeProperty('--sg-accent-hover');
    };
  }, [branding]);
  return branding;
}

// ── Header: brand + security note; in the workspace also the subject, progress,
// Help and Decline. Never any navigation into an Aramo app. ──
export function Header({
  title,
  progress,
  onDecline,
  reportToken,
  selfSigning = false,
}: {
  readonly title?: string;
  readonly progress?: string;
  readonly onDecline?: () => void;
  /** M-A7 §5.2 — the signing token, for the Report action in Help. */
  readonly reportToken?: string;
  /** UAT SND-11 (A2-A3) — the caller's own "Sign a document": self-signing Help, no Report. */
  readonly selfSigning?: boolean;
}) {
  const [help, setHelp] = useState(false);
  const brand = useContext(SignerBrandingContext);
  return (
    <header className="sg-head">
      {brand?.logo_url ? (
        <img className="sg-logo" src={brand.logo_url} alt={brand.display_name ?? 'Sender logo'} data-testid="sg-brand-logo" />
      ) : (
        <span className="sg-mark" aria-hidden="true">
          {brand?.display_name ? brand.display_name.charAt(0).toUpperCase() : 'S'}
        </span>
      )}
      <span className="sg-head__text">
        <span className="sg-head__title">{title ?? brand?.display_name ?? 'Aramo Sign'}</span>
        <span className="sg-head__sub">
          <LockIcon /> {brand?.display_name && title ? `${brand.display_name} · ` : ''}Secured by Aramo Sign{progress ? ` · ${progress}` : ''}
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
          {selfSigning ? (
            <>
              You&apos;re signing your own document. Nobody is emailed. When you finish, the signed PDF and the
              certificate are on the envelope in your Aramo Sign workspace.
            </>
          ) : (
            <>
              Questions about this document? Reply to the email that brought you here, or contact the person who sent
              it. Your signing link is personal — don&apos;t forward it.
            </>
          )}
          {!selfSigning && reportToken !== undefined && reportHrefForToken(reportToken) !== null ? (
            <>
              {' '}
              Don&apos;t know the sender, or think it&apos;s a scam? <ReportLink token={reportToken} className="sg-help__link" />.
            </>
          ) : null}
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
      el ? [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, canvas[tabindex]')].filter((n) => !n.hasAttribute('disabled')) : [];
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
  saved,
  canSave,
  onAdopt,
  onClose,
}: {
  readonly kind: 'SIGNATURE' | 'INITIALS';
  readonly suggestedName: string;
  // M-A15 §6 — the signer's saved mark for this kind (null: none offered).
  readonly saved: GuestSavedMark | null;
  // M-A15 §4.1 — a signed-in signing session may save a new default.
  readonly canSave: boolean;
  readonly onAdopt: (a: Adopted, saveDefault: boolean) => void;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<'TYPED' | 'DRAWN'>('TYPED');
  // As in the app: checked when nothing is saved yet, unchecked when replacing a default.
  const [saveDefault, setSaveDefault] = useState(saved === null);
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
    const save = canSave && saveDefault;
    if (tab === 'TYPED') onAdopt({ method: 'TYPED', value: typed.trim(), display: typed.trim() }, save);
    else onAdopt({ method: 'DRAWN', value: canvasRef.current ? trimmedSignaturePng(canvasRef.current) : '', display: 'Drawn' }, save);
  };

  return (
    <Dialog title={kind === 'INITIALS' ? 'Adopt your initials' : 'Adopt your signature'} onClose={onClose}>
      {saved !== null ? (
        // M-A15 §6 — the saved default, one tap; Type / Draw below stay available.
        <div className="sg-saved" data-testid="sg-saved-mark">
          <img src={saved.image_data_url} alt={`Your saved ${label}`} className="sg-saved__img" />
          <Btn onClick={() => onAdopt(adoptedFromSaved(saved, kind), false)} data-testid="sg-use-saved">
            {kind === 'INITIALS' ? 'Use my saved initials' : 'Use my saved signature'}
          </Btn>
          <p className="sg-muted sg-small">Or create a different one:</p>
        </div>
      ) : null}
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
      {canSave ? (
        <label className="sg-agree">
          <CheckIn checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} data-testid="sg-save-default" />
          {kind === 'INITIALS' ? 'Save as my default initials' : 'Save as my default signature'}
        </label>
      ) : null}
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

// FIELD-PARITY-1 P3 §6 — the editor for every field the signer types or picks: text and the
// profile types, MULTILINE_TEXT (counter), NUMBER (money prefix, decimal keypad), DATE (the
// browser's date picker inside the field's date_range; stored YYYY-MM-DD, previewed in the
// envelope's date format) and DROPDOWN (the sender's choices). The caption is the field's label
// (S-1), the help text its tooltip, the hint its placeholder (S-2). A value the server would
// refuse (@aramo/sign-client signerValueProblem) is named inline, announced, and focused; a
// refusal the server still returns comes back through onSave and is shown the same way.
export function FieldDialog({
  field,
  title,
  initial,
  dateFormat,
  onSave,
  onClose,
}: {
  readonly field: SignField;
  readonly title: string;
  readonly initial: string;
  readonly dateFormat: string | null | undefined;
  /** Resolves to the refusal message to show, or null when saved. */
  readonly onSave: (v: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const kind = signerInputKind(field.field_type);
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
  const id = `sg-fe-${field.field_id}`;
  const help = signerFieldTooltip(field);
  const hint = fieldInputHint(field, { date_format: dateFormat ?? null });
  const placeholder = signerFieldPlaceholder(field) ?? undefined;
  const limit = fieldInputLimit(field);
  const prefix = numberPrefixOf(field);
  const bounds = dateBoundsOf(field);
  const choices = kind === 'dropdown' ? dropdownChoicesOf(field) : [];
  const describedBy = [help !== null ? `${id}-help` : null, hint !== null ? `${id}-hint` : null, error !== null ? `${id}-err` : null].filter((x) => x !== null).join(' ') || undefined;
  const common = {
    id,
    ref: input,
    value: v,
    'aria-invalid': error !== null,
    'aria-describedby': describedBy,
    'aria-required': field.required,
  } as const;
  const change = (next: string) => {
    setV(next);
    if (error !== null) setError(null);
  };
  const apply = async () => {
    const value = normalizeSignerInput(field, v);
    const problem = signerValueProblem(field, value);
    if (problem !== null) {
      setError(fieldValueRefusalText(problem, field, { date_format: dateFormat ?? null }));
      input.current?.focus();
      return;
    }
    setSaving(true);
    const refused = await onSave(value);
    setSaving(false);
    if (refused !== null) {
      setError(refused);
      input.current?.focus();
    }
  };
  const preview = kind === 'date' && isIsoDate(v) ? formatChosenDate(v, dateFormat) : null;
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="sg-fieldedit">
        <label className="sg-fieldedit__label" htmlFor={id}>
          {title}
          {field.required ? '' : ' (optional)'}
        </label>
        {help !== null ? (
          <p className="sg-fieldedit__help" id={`${id}-help`}>
            {help}
          </p>
        ) : null}
        {kind === 'multiline' ? (
          <TextBox {...common} rows={5} placeholder={placeholder} maxLength={limit ?? undefined} onChange={(e) => change(e.target.value)} />
        ) : kind === 'dropdown' ? (
          <SelectIn {...common} onChange={(e) => change(e.target.value)}>
            <option value="" disabled>
              {placeholder ?? 'Choose an option'}
            </option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectIn>
        ) : kind === 'date' ? (
          <TextIn {...common} type="date" min={bounds.min ?? undefined} max={bounds.max ?? undefined} placeholder={placeholder} onChange={(e) => change(e.target.value)} />
        ) : kind === 'number' ? (
          <span className="sg-fieldedit__row">
            {prefix !== null ? (
              <span className="sg-fieldedit__prefix" aria-hidden="true">
                {prefix}
              </span>
            ) : null}
            <TextIn {...common} inputMode="decimal" placeholder={placeholder} onChange={(e) => change(e.target.value)} />
          </span>
        ) : (
          <TextIn
            {...common}
            type={field.validation === 'email' || field.field_type === 'EMAIL' ? 'email' : field.validation === 'phone' ? 'tel' : 'text'}
            inputMode={field.validation === 'us_zip' ? 'numeric' : undefined}
            placeholder={placeholder}
            maxLength={limit ?? undefined}
            onChange={(e) => change(e.target.value)}
          />
        )}
        {hint !== null ? (
          <p className="sg-fieldedit__help" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
        {preview !== null ? (
          <p className="sg-fieldedit__help" data-testid="sg-date-preview">
            Shown on the document as {preview}
          </p>
        ) : null}
        {kind === 'multiline' && limit !== null ? (
          <p className="sg-fieldedit__count" aria-live="polite" data-testid="sg-count">
            {v.length} / {limit}
          </p>
        ) : null}
        {error !== null ? (
          <p className="sg-error" role="alert" id={`${id}-err`} data-testid="sg-field-error">
            {error}
          </p>
        ) : null}
      </div>
      <div className="sg-dialog__foot">
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn disabled={saving || v.trim().length === 0} onClick={() => void apply()}>
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
        The sender will see that you declined and the reason you give. You won&apos;t be able to sign this document with this link
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
          disabled={!isValidDeclineReason(reason) || busy}
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

// Feature-Parity §1.9 — the recipient enters the access code the sender gave them
// before anything of the document is shown. The code is sent once and never kept.
/** UAT SEC-04 — a wrong code says how many tries are left (the server counts; the fifth locks). */
export function accessCodeWrongText(left: number | null): string {
  if (left === null) return "That code isn't right. Check it and try again.";
  return `That code isn't right. ${left} ${left === 1 ? 'attempt' : 'attempts'} left before this document is locked.`;
}

export type AccessCodeResult = { kind: 'ok' } | { kind: 'incorrect'; left: number | null };

function AccessCodeCard({ onSubmit }: { readonly onSubmit: (code: string) => Promise<AccessCodeResult> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<{ left: number | null } | null>(null);
  return (
    <main className="sg-center">
      <div className="sg-card" data-testid="sg-access-code">
        <h1>Enter the access code</h1>
        <p className="sg-muted">The sender protected this document with an access code. They will have given it to you separately.</p>
        <label className="sg-label">
          Access code
          <TextIn value={code} onChange={(e) => setCode(e.target.value)} aria-label="Access code" autoComplete="off" />
        </label>
        {wrong ? (
          <p className="sg-error" role="alert" data-testid="sg-access-code-wrong">
            {accessCodeWrongText(wrong.left)}
          </p>
        ) : null}
        <Btn
          className="sg-btn--block"
          disabled={code.trim().length === 0 || busy}
          onClick={() => {
            setBusy(true);
            void onSubmit(code).then((r) => {
              setWrong(r.kind === 'incorrect' ? { left: r.left } : null);
              setBusy(false);
            });
          }}
        >
          Continue
        </Btn>
      </div>
    </main>
  );
}

// Feature-Parity §1.9 — the recipient asks for a code by SMS and enters it before anything of
// the document is shown. The code is checked by the server and never kept here.
function SmsCodeCard({ token, onVerified, onLocked }: { readonly token: string; readonly onVerified: () => void; readonly onLocked: () => void }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    signApi
      .smsCodeStatus(token)
      .then((s) => {
        if (live) setPhone(s.phone);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token]);
  const send = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await signApi.smsCodeSend(token);
      if (r.verified) return onVerified();
      setSent(true);
      if (r.phone !== null) setPhone(r.phone);
    } catch (e) {
      const reason = e instanceof SignApiError ? e.reason : undefined;
      if (reason === 'otp_locked') return onLocked();
      setMessage(
        reason === 'otp_resend_cooldown'
          ? 'Wait a minute before asking for another code.'
          : reason === 'otp_daily_limit'
            ? 'You have asked for too many codes today. Try again tomorrow, or contact the sender.'
            : reason === 'otp_opted_out'
              ? 'This number has stopped text messages from Aramo Sign. Contact the sender.'
              : "The code couldn't be sent. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await signApi.smsCodeVerify(token, code.trim());
      onVerified();
    } catch (e) {
      const reason = e instanceof SignApiError ? e.reason : undefined;
      if (reason === 'otp_locked') return onLocked();
      setMessage(
        reason === 'otp_mismatch'
          ? "That code isn't right. Check it and try again."
          : reason === 'otp_expired'
            ? 'This code has expired. Send a new one.'
            : reason === 'otp_code_locked'
              ? 'Too many incorrect codes. Send a new code.'
              : reason === 'otp_not_requested'
                ? 'Send a code first.'
                : "That didn't go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="sg-center">
      <div className="sg-card" data-testid="sg-sms-code">
        <h1>Enter the code we text you</h1>
        <p className="sg-muted">
          The sender asked us to confirm your phone before you open this document. We&apos;ll text a code to {phone ?? 'your phone'}.
        </p>
        {sent ? (
          <label className="sg-label">
            Code
            <TextIn value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" autoComplete="one-time-code" inputMode="numeric" />
          </label>
        ) : null}
        {message !== null ? (
          <p className="sg-error" role="alert">
            {message}
          </p>
        ) : null}
        {sent ? (
          <>
            <Btn className="sg-btn--block" disabled={code.trim().length === 0 || busy} onClick={() => void verify()}>
              Continue
            </Btn>
            <Btn variant="quiet" className="sg-btn--block" disabled={busy} onClick={() => void send()}>
              Send a new code
            </Btn>
          </>
        ) : (
          <Btn className="sg-btn--block" disabled={busy} onClick={() => void send()}>
            Text me a code
          </Btn>
        )}
      </div>
    </main>
  );
}

// Consolidated Directive B3 (Feature-Parity §1.17) — the signer hands their part to another
// person (the sender allowed it). The delegate gets their own link; this one stops working.
function DelegateDialog({ onDelegate, onClose }: { readonly onDelegate: (input: { name: string; email: string; reason?: string }) => Promise<string | null>; readonly onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // C3 (audit row 28) — the delegate rule shared with the server and the app (email ≤254, reason ≤500).
  const ok = isValidDelegate({ name, email, reason });
  return (
    <Dialog title="Ask someone else to sign" onClose={onClose}>
      <p className="sg-muted">
        They&apos;ll get an email with their own link and sign in their own name. Your link stops working, and the sender can see the hand-off.
      </p>
      <label className="sg-label">
        Their full name
        <TextIn value={name} onChange={(e) => setName(e.target.value)} aria-label="Their full name" />
      </label>
      <label className="sg-label">
        Their email
        <TextIn type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Their email" />
      </label>
      <label className="sg-label">
        Reason (optional)
        <TextBox value={reason} onChange={(e) => setReason(e.target.value.slice(0, DELEGATE_REASON_MAX))} rows={2} aria-label="Reason (optional)" />
      </label>
      {error !== null ? (
        <p className="sg-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="sg-dialog__foot">
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          disabled={!ok || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void onDelegate({ name: name.trim(), email: email.trim(), ...(reason.trim() !== '' ? { reason: reason.trim() } : {}) })
              .then(setError)
              .finally(() => setBusy(false));
          }}
        >
          Send to them
        </Btn>
      </div>
    </Dialog>
  );
}

const QES_FAILED = 'The qualified signature was not completed. Go back to the document and try again, or contact the sender.';

function safeRedirect(url: string | null): string | null {
  return url !== null && /^https:\/\//.test(url) ? url : null;
}

/**
 * Consolidated Directive B3 — the page the trust service provider returns the signer to
 * (/qes/callback?code=…&state=…). It finishes the step with the token kept in this tab:
 * after the identity step the provider is opened again to sign; once signed, the signer goes
 * back to the document to finish.
 */
export function QesCallback({ token }: { readonly token: string }): JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code');
    const state = q.get('state');
    if (token.length === 0) {
      setMessage('This page has expired. Open the signing link from your email again.');
      return;
    }
    if (q.get('error') !== null || code === null || state === null) {
      setMessage(QES_FAILED);
      return;
    }
    signApi
      .qesComplete(token, code, state)
      .then((r) => {
        const next = safeRedirect(r.redirect_url);
        if (next !== null) window.location.assign(next);
        else if (r.state === 'SIGNED') window.location.replace(QES_RETURN_PATH);
        else setMessage(QES_FAILED);
      })
      .catch(() => setMessage(QES_FAILED));
  }, [token]);
  return (
    <>
      <Header />
      <main className="sg-center" data-testid="sg-qes-callback">
        <div className="sg-card">
          {message === null ? (
            <p className="sg-muted" aria-busy="true">
              Finishing your qualified signature…
            </p>
          ) : (
            <>
              <h1>Qualified signature</h1>
              <p role="alert">{message}</p>
              {token.length > 0 ? (
                <Btn className="sg-btn--block" onClick={() => window.location.replace(QES_RETURN_PATH)}>
                  Back to the document
                </Btn>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}

// ── End-state screens: plain language, no link into any Aramo app ──
// (M-A16 §2 — the one exception: "Save to my Aramo inbox" on the signed screen.)
export function EndState({ tone, title, body, children }: { readonly tone: 'ok' | 'muted' | 'error'; readonly title: string; readonly body: string; readonly children?: React.ReactNode }) {
  return (
    <main className="sg-center" data-testid="sg-end-state">
      <div className={`sg-card sg-card--${tone}`}>
        <h1>{title}</h1>
        <p>{body}</p>
        {children}
        <p className="sg-muted sg-small">You can close this page.</p>
      </div>
    </main>
  );
}

// M-A16 §2 — after signing from an emailed link: hand the token to the workspace (this
// tab's sessionStorage, never a URL) and open it; the workspace adds it to the inbox.
function SaveToInbox({ token }: { readonly token: string }) {
  const [blocked, setBlocked] = useState(false);
  const save = () => {
    if (!stashInboxClaim(token)) {
      setBlocked(true);
      return;
    }
    window.location.assign('/');
  };
  return (
    <div className="sg-saveinbox" data-testid="sg-save-to-inbox">
      <Btn variant="secondary" onClick={save}>
        Save to my Aramo inbox
      </Btn>
      <p className="sg-muted sg-small">
        {blocked
          ? 'Your browser blocked this. In Aramo Sign, open Waiting for me and paste the “Review and sign” link from your email.'
          : 'Sign in to Aramo Sign to keep this document in your inbox.'}
      </p>
    </div>
  );
}

export function App(): JSX.Element {
  const [token] = useState<string>(tokenFromLocation);
  const branding = useSignerBranding(token);
  return (
    <SignerBrandingContext.Provider value={branding}>
      {window.location.pathname === QES_CALLBACK_PATH ? <QesCallback token={token} /> : <SignerApp token={token} />}
    </SignerBrandingContext.Provider>
  );
}

/**
 * Web Self-Signing A2 §3.4 — the workspace's return hint for a document the sender signs
 * themselves (`?ret=`). Display only (it grants nothing): accepted only as a same-origin
 * workspace envelope path; anything else is null and the usual done screen shows.
 */
export function selfSignReturn(search: string): string | null {
  const ret = new URLSearchParams(search).get('ret');
  if (ret === null) return null;
  return /^\/(sign|personal)\/envelopes\/[0-9a-f-]{36}$/i.test(ret) ? ret : null;
}

function SignerApp({ token }: { readonly token: string }): JSX.Element {
  const selfReturn = useState(() => selfSignReturn(window.location.search))[0];
  // UAT SND-11 (A2-A3) — the caller's own "Sign a document" (from the server's exchange): no
  // outside-signer wording, no Decline and no Report (nobody asked, nobody to decline to).
  const [selfSigning, setSelfSigning] = useState(false);
  const headerProps = selfSigning ? { selfSigning: true } : { reportToken: token };
  const [screen, setScreen] = useState<Screen>(token.length === 0 ? 'invalid' : 'loading');
  const [view, setView] = useState<SignerDocumentView | null>(null);
  // M-A15 §4.1 — the signer's saved signature / initials offered on this page.
  const [savedMarks, setSavedMarks] = useState<GuestSavedMarks | null>(null);
  const [docUrls, setDocUrls] = useState<Record<string, string>>({});
  // PX-2 — the source bytes (base64) per document, rendered page by page with the
  // signer's fields in place; the browser PDF viewer is only the fallback.
  const [docB64, setDocB64] = useState<Record<string, string>>({});
  const [renderFailed, setRenderFailed] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [filled, setFilled] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [disclosure, setDisclosure] = useState<SignerDisclosure | null>(null);
  const [adopted, setAdopted] = useState<{ SIGNATURE?: Adopted; INITIALS?: Adopted }>({});
  const [adoptFor, setAdoptFor] = useState<SignField | null>(null);
  const [textFor, setTextFor] = useState<SignField | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [finishError, setFinishError] = useState(false);
  const [allSigned, setAllSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeField, setActiveField] = useState<string | null>(null);
  // FIELD-PARITY-1 P3 — accessibility: after a refused Finish, focus moves to the first field
  // still to do (its action in "Your fields"), or to the notice when there is none.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId === null) return;
    const el = document.getElementById(focusId === NOTICE_FOCUS ? 'sg-notice' : `sg-act-${focusId}`);
    el?.focus();
    setFocusId(null);
  }, [focusId, screen]);
  // B3 — the qualified-signature step (null = not required) and the delegation hand-off.
  const [qes, setQes] = useState<QesStatus | null>(null);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [delegatedTo, setDelegatedTo] = useState('');
  // Sign 1.14 — the workspace loader, for the payment return (declared below).
  const loadWorkspaceRef = useRef<() => Promise<void>>(async () => undefined);

  const fail = useCallback((e: unknown) => setScreen(screenForError(e)), []);
  const onRenderError = useCallback(() => setRenderFailed(true), []);

  const open = useCallback(() => {
    if (token.length === 0) return;
    setScreen('loading');
    const back = paymentReturn();
    const qesBack = window.location.pathname === QES_RETURN_PATH;
    signApi
      .exchange(token)
      .then((x) => {
        // UAT SND-11 (A2-A3) — the server says when this is the caller's own "Sign a document".
        setSelfSigning(x.self_signing === true);
        return signApi.disclosureText(token);
      })
      .then(async (d) => {
        setDisclosure(d);
        // Sign 1.14 — back from Stripe: confirm the payment (the server reads it from
        // Stripe), then return to the document (the disclosure was already accepted).
        // B3 — back from the trust service provider: return to Review & finish.
        if (qesBack) {
          try {
            await loadWorkspaceRef.current();
            setScreen('review');
            return;
          } catch {
            // Fall back to the start of the signing flow.
          }
        }
        if (back !== null) {
          try {
            const r = await signApi.confirmPayment(token, back.field_id);
            await loadWorkspaceRef.current();
            if (r.status !== 'PAID') setNotice('The payment was not completed. You can pay again from the payment field.');
            return;
          } catch {
            // Fall back to the start of the signing flow.
          }
        }
        setScreen('landing');
      })
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
    setSavedMarks(v.saved_marks ?? null);
    setDocUrls(urls);
    setDocB64(b64);
    // Restore progress after a reload: the backend returns this signer's own
    // entries, so the page shows the actual signature / date / text in place.
    setFilled((m) => {
      const next = { ...m };
      for (const f of v.fields) {
        // FIELD-PARITY-1 P3 S-4 / S-5 — the sender's value is shown as it is (never the signer's).
        if (isLocked(f)) {
          if (typeof f.value === 'string' && f.value.length > 0) next[f.field_id] = f.value;
          else delete next[f.field_id];
          continue;
        }
        if (f.filled === true && next[f.field_id] === undefined) next[f.field_id] = typeof f.value === 'string' && f.value.length > 0 ? f.value : FILLED_MARK;
      }
      // FIELD-PARITY-2 B-6 / C-3 — no answer is kept for a field these answers hide.
      return withoutHiddenAnswers(v.fields, next);
    });
    setActiveDoc(v.documents.slice().sort((a, b) => a.ordinal - b.ordinal)[0]?.document_id ?? null);
    // B3 — refused while sign.qes is not available: then no qualified signature is asked for.
    setQes(await signApi.qesStatus(token).then((r) => r.qes ?? null, () => null));
    setScreen('workspace');
  };

  // Feature-Parity §1.9 — open the verification vendor's page in a new tab; on return the
  // recipient continues here and the document opens once the check has passed.
  const [idMessage, setIdMessage] = useState<string | null>(null);
  const startIdentityCheck = async () => {
    setBusy(true);
    setIdMessage(null);
    try {
      const r = await signApi.identityStart(token);
      if (r.state === 'VERIFIED') return await loadWorkspace();
      if (typeof r.verification_url === 'string' && r.verification_url.length > 0) {
        window.open(r.verification_url, '_blank', 'noopener');
        setIdMessage('Finish the check in the new tab, then come back and select Continue.');
      } else setIdMessage('Your check is being processed. Select Continue in a moment.');
    } catch (e) {
      if (e instanceof SignApiError && e.code === 'ESIGN_IDENTITY_VERIFICATION_UNAVAILABLE') setIdMessage('Identity checks are not available right now. Try again later.');
      else fail(e);
    } finally {
      setBusy(false);
    }
  };
  const continueAfterIdentityCheck = async () => {
    setBusy(true);
    setIdMessage(null);
    try {
      const r = await signApi.identityStatus(token);
      if (r.state === 'VERIFIED') await loadWorkspace();
      else if (r.state === 'LOCKED') setScreen('idlocked');
      else if (r.state === 'PENDING') setIdMessage('Your check is not finished yet. Complete it in the other tab, or wait a moment and try again.');
      else
        setIdMessage(
          r.last_failure !== null
            ? `That check did not pass (${r.last_failure.replace(/_/g, ' ')}). ${r.attempts_remaining ?? 0} attempt(s) left.`
            : 'Start the identity check to continue.',
        );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  loadWorkspaceRef.current = loadWorkspace;

  const acceptAndContinue = async () => {
    setBusy(true);
    try {
      if (disclosure === null) throw new SignApiError('DISCLOSURE_UNAVAILABLE', 0);
      await signApi.acceptDisclosure(token, disclosure);
      await loadWorkspace();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const fields = useMemo(() => view?.fields ?? [], [view]);
  // M-A6 §2.3 — required fields, required boxes and group rules, as the server
  // checks them at completion. A server-filled name is never the signer's to do.
  const reqs = useMemo(() => requirements(fields, filled), [fields, filled]);
  const required = reqs;
  const doneRequired = reqs.filter((r) => r.done).length;
  const problem = completionProblem(fields, filled);
  const progress = `${doneRequired} of ${required.length} required fields filled`;
  // FIELD-PARITY-2 B-6 — the fields shown for the signer's current answers (the one visibility
  // rule, @aramo/sign-client): only they are listed, drawn on the page and offered by Next. A
  // hidden field is not rendered at all, so it is never focusable nor in the reading order. The
  // rules above take every field (a hidden trigger keeps its dependents hidden).
  const shownList = useMemo(() => shownSignFields(fields, filled), [fields, filled]);
  const pending = (f: SignField): boolean => awaitsSigner(f, filled);
  const nextField = nextFieldToDo(fields, filled);
  const title = view?.documents.slice().sort((a, b) => a.ordinal - b.ordinal)[0]?.title;

  // M-A15 §4.2 / §6 — "Save as my default" (a signed-in signing session). Best effort:
  // a failed save never blocks signing.
  const saveAsDefault = async (kind: 'SIGNATURE' | 'INITIALS', a: Adopted) => {
    const slot = kind === 'INITIALS' ? 'initials' : 'signature';
    try {
      const saved: GuestSavedMark = await signApi.saveMark(
        token,
        slot,
        a.method === 'TYPED'
          ? { kind: 'TYPED', typed_name: typedNameToStore(kind, a.value), font_key: SAVED_MARK_FONT_KEY, image_data_url: await typedSignaturePng(a.value) }
          : { kind: 'DRAWN', image_data_url: a.value },
      );
      setSavedMarks((m) => (m === null ? m : { ...m, [slot]: saved }));
    } catch {
      setNotice(kind === 'INITIALS' ? 'Your initials weren’t saved as your default. Signing isn’t affected.' : 'Your signature wasn’t saved as your default. Signing isn’t affected.');
    }
  };

  // Save one field. FIELD-PARITY-1 P3 — a value the server refuses (VALIDATION_ERROR with a
  // value reason) comes back as its plain-language message (@aramo/sign-client), never the
  // server's text; `message: null` means the page moved to another screen.
  const save = async (f: SignField, value: string, method?: string): Promise<{ ok: true } | { ok: false; message: string | null }> => {
    setBusy(true);
    setNotice(null);
    try {
      await signApi.fillField(token, f.field_id, value, method);
      // FIELD-PARITY-2 B-6 / C-3 — when this answer hides fields, the server has cleared them;
      // the page clears its own copy of those answers to match.
      setFilled((m) => withoutHiddenAnswers(fields, { ...m, [f.field_id]: value }));
      return { ok: true };
    } catch (e) {
      if (e instanceof SignApiError && isFieldValueRefusalReason(e.reason)) return { ok: false, message: fieldValueRefusalText(e.reason, f, { date_format: view?.date_format ?? null }) };
      const s = screenForError(e);
      if (s === 'error' || s === 'network') return { ok: false, message: SAVE_FAILED };
      setScreen(s);
      return { ok: false, message: null };
    } finally {
      setBusy(false);
    }
  };
  const fill = async (f: SignField, value: string, method?: string): Promise<boolean> => {
    const r = await save(f, value, method);
    if (!r.ok && r.message !== null) setNotice(r.message);
    return r.ok;
  };

  // UAT SIG-03 — Start / Next field brings a check box into view without checking it
  // (as in the app): the signer checks it themselves, so a tap on the box afterwards
  // never silently unchecks a box Next had already checked.
  const goTo = (f: SignField) => {
    setActiveField(f.field_id);
    if (f.document_id !== activeDoc) setActiveDoc(f.document_id);
  };
  // FIELD-PARITY-1 P3 — accessibility: Start / Next field on a box (or a radio option) also
  // moves keyboard focus to it in "Your fields".
  const focusOn = (f: SignField) => {
    goTo(f);
    setFocusId(f.field_id);
  };

  // Every field stays editable until Finish signing (the backend accepts a new
  // value while the session is live): a filled signature / initials reopens the
  // adopt dialog to change it, a filled text field reopens its editor.
  const act = (f: SignField) => {
    setActiveField(f.field_id);
    if (f.document_id !== activeDoc) setActiveDoc(f.document_id);
    const t = f.field_type;
    const done = filled[f.field_id] !== undefined;
    // M-A6 §2.2 — the server fills this name; the page never sends one.
    if (isServerName(f)) return;
    // FIELD-PARITY-1 P3 S-4 / S-5 — the sender's value is shown, never changed here.
    if (isLocked(f)) return;
    // Sign 1.14 — a payment is made on Stripe's hosted page (never on this page).
    if (isPayment(f)) {
      if (done) return;
      void pay(f);
      return;
    }
    if (t === 'SIGNATURE' || t === 'INITIALS') {
      const a = adopted[t];
      if (a && !done) void fill(f, a.value, a.method);
      else setAdoptFor(f);
    } else if (t === 'SIGN_DATE') {
      // M-A12 W1-E.2 / C0-2 — a PREVIEW in the envelope's stamped format; the server stamps
      // the stored SIGN_DATE at signing (Client Rule Consolidation C2: the shared formatter).
      if (!done) void fill(f, signDatePreview(view?.date_format));
    } else if (isRadio(f)) {
      void choose(f);
    } else if (t === 'CHECKBOX' || t === 'ACKNOWLEDGEMENT') {
      void toggle(f);
    } else setTextFor(f);
  };
  // FIELD-PARITY-1 P3 T-5 — choosing a radio button: the server clears the group's other
  // options, so the page shows them cleared once the choice is saved. FIELD-PARITY-2 A-2 —
  // tapping the chosen option of an OPTIONAL set clears it ('false'); a required set keeps its
  // choice (choose another option to change it). The shared rule decides (radioChoiceClearable).
  const choose = async (f: SignField) => {
    if (isChecked(filled[f.field_id])) {
      if (radioChoiceClearable(f, shownList)) await fill(f, 'false');
      return;
    }
    if (!(await fill(f, 'true'))) return;
    const others = selectOneSiblings(shownList, f);
    setFilled((m) => {
      const next = { ...m };
      for (const o of others) next[o.field_id] = 'false';
      return withoutHiddenAnswers(fields, next);
    });
  };
  // M-A6 §2.3 — a box toggles: checking sends 'true', unchecking 'false'. In a
  // SELECT_ONE group, checking one box unchecks the others.
  const toggle = async (f: SignField) => {
    if (isChecked(filled[f.field_id])) {
      await fill(f, 'false');
      return;
    }
    for (const o of selectOneSiblings(shownList, f)) {
      if (isChecked(filled[o.field_id]) && !(await fill(o, 'false'))) return;
    }
    await fill(f, 'true');
  };
  // Sign 1.14 — send the payer to Stripe's hosted Checkout (the organization's own Stripe
  // account). The token stays in this tab for the return; it is never sent to Stripe.
  const pay = async (f: SignField) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await signApi.startPayment(token, f.field_id);
      if (r.status === 'PAID') {
        await loadWorkspace();
        return;
      }
      try {
        window.sessionStorage.setItem(PAYMENT_TOKEN_KEY, token);
      } catch {
        setNotice('Your browser blocked the payment page. Allow site storage for this page and try again.');
        return;
      }
      window.location.assign(r.checkout_url);
    } catch (e) {
      const s = screenForError(e);
      if (e instanceof SignApiError && (e.code === 'ESIGN_FEATURE_NOT_AVAILABLE' || e.reason === 'payments_account_not_ready')) {
        setNotice('The sender cannot take payments right now. Contact the sender.');
      } else if (s === 'error' || s === 'network') setNotice('The payment page could not be opened. Try again in a moment.');
      else setScreen(s);
    } finally {
      setBusy(false);
    }
  };
  const editable = (f: SignField): boolean => f.field_type !== 'SIGN_DATE' && !isBox(f) && !isServerName(f) && !isPayment(f) && !isLocked(f);
  const statusOf = (f: SignField): string => {
    if (isServerName(f)) return 'From the signing request';
    if (isLocked(f)) return SENDER_VALUE;
    if (isRadio(f)) return isChecked(filled[f.field_id]) ? 'Chosen' : 'Not chosen';
    if (isPayment(f)) {
      const amount = f.payment ? formatAmount(f.payment.amount_minor, f.payment.currency) : '';
      return filled[f.field_id] !== undefined ? `Paid ${amount}` : `Payment required · ${amount}`;
    }
    if (isBox(f)) return isChecked(filled[f.field_id]) ? 'Checked' : 'Not checked';
    return filled[f.field_id] !== undefined ? 'Filled' : f.required ? 'Required' : 'Optional · skipped';
  };
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
        setNotice(incompleteMessage(e.reason));
        // Focus the first field still to do (the notice is announced either way).
        if (nextField !== null) goTo(nextField);
        setFocusId(nextField?.field_id ?? NOTICE_FOCUS);
      } else {
        const s = screenForError(e);
        if (s === 'error' || s === 'network') setFinishError(true);
        else setScreen(s);
      }
    } finally {
      setBusy(false);
    }
  };

  // B3 — send the signer to the trust service provider (the token stays in this tab).
  const startQes = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await signApi.qesBegin(token);
      const next = safeRedirect(r.redirect_url);
      if (next === null) {
        setNotice(QES_FAILED);
        return;
      }
      try {
        window.sessionStorage.setItem(QES_TOKEN_KEY, token);
      } catch {
        setNotice('Your browser blocked the signing page. Allow site storage for this page and try again.');
        return;
      }
      window.location.assign(next);
    } catch (e) {
      const s = screenForError(e);
      if (e instanceof SignApiError && (e.code === 'ESIGN_FEATURE_NOT_AVAILABLE' || e.status === 503)) setNotice('Qualified signatures are not available right now. Contact the sender.');
      else if (s === 'error' || s === 'network') setNotice("The signing page couldn't be opened. Try again in a moment.");
      else setScreen(s);
    } finally {
      setBusy(false);
    }
  };

  // B3 — hand the signature to someone else. Returns the message to show, or null when done.
  const delegate = async (input: { name: string; email: string; reason?: string }): Promise<string | null> => {
    try {
      await signApi.delegate(token, input);
      setDelegatedTo(input.name);
      setDelegateOpen(false);
      setScreen('delegated');
      return null;
    } catch (e) {
      if (e instanceof SignApiError) {
        if (e.reason === 'delegate_invalid') return "Enter the person's name and a valid email.";
        if (e.reason === 'delegate_email_on_envelope') return 'That person is already on this document.';
        if (e.code === 'ENVELOPE_ILLEGAL_TRANSITION' || e.code === 'ESIGN_FEATURE_NOT_AVAILABLE') return "This document can't be handed off now.";
      }
      const s = screenForError(e);
      if (s !== 'error' && s !== 'network') {
        setDelegateOpen(false);
        setScreen(s);
        return null;
      }
      return "That didn't go through. Try again.";
    }
  };

  const submitAccessCode = async (code: string): Promise<AccessCodeResult> => {
    try {
      await signApi.accessCode(token, code);
      open();
      return { kind: 'ok' };
    } catch (e) {
      if (e instanceof SignApiError && e.code === 'SIGNER_ACCESS_CODE_REQUIRED') return { kind: 'incorrect', left: e.attemptsRemaining ?? null };
      fail(e);
      return { kind: 'ok' };
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
    if (isRadio(f)) return isChecked(v) ? { kind: 'mark', value: RADIO_MARK } : null;
    if (isBox(f)) return isChecked(v) ? { kind: 'mark', value: FILLED_MARK } : null;
    if (v.startsWith('data:image/')) return { kind: 'image', value: v };
    if (v === FILLED_MARK) return { kind: 'mark', value: FILLED_MARK };
    // FIELD-PARITY-1 P3 — a chosen date in the envelope's format, a number as printed (money
    // with its currency), a dropdown as its choice's label: what the executed PDF prints.
    return { kind: 'text', value: fieldValueDisplay(f, v, { date_format: view?.date_format ?? null }) };
  };

  // ── End states ──
  if (screen === 'invalid')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="error" title="This signing link isn't valid" body="The link may be incomplete or mistyped. Open it again from your email, or ask the sender to send a new one." />
      </>
    );
  if (screen === 'expired')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="muted" title="This link is no longer active" body="It has expired or has already been used to sign. If you still need to sign, ask the sender to send you a new link." />
      </>
    );
  if (screen === 'ended')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="muted" title="This document is no longer available to sign" body="Signing has ended for this document — it may have been completed, declined or withdrawn by the sender." />
      </>
    );
  if (screen === 'notyet')
    return (
      <>
        <Header {...headerProps} />
        <EndState
          tone="muted"
          title="It's not your turn to sign yet"
          body="This document is signed in a set order, and someone before you hasn't signed yet. We'll email you a new link as soon as it's your turn."
        />
      </>
    );
  if (screen === 'accesscode')
    return (
      <>
        <Header {...headerProps} />
        <AccessCodeCard onSubmit={submitAccessCode} />
      </>
    );
  if (screen === 'smscode')
    return (
      <>
        <Header {...headerProps} />
        <SmsCodeCard token={token} onVerified={open} onLocked={() => setScreen('smslocked')} />
      </>
    );
  if (screen === 'smslocked')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="error" title="Too many incorrect codes" body="For your security this document is locked. Contact the sender if you still need to sign." />
      </>
    );
  if (screen === 'delegated')
    return (
      <>
        <Header />
        <EndState
          tone="ok"
          title={`Sent to ${delegatedTo}`}
          body={`${delegatedTo} will get an email with their own link to sign. This link no longer works for you.`}
        />
      </>
    );
  if (screen === 'locked')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="error" title="Too many incorrect access codes" body="For your security this document is locked. Contact the sender if you still need to sign." />
      </>
    );
  if (screen === 'idlocked')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="muted" title="We couldn't verify your identity" body="The sender has been told and may send you a new request. You can close this page." />
      </>
    );
  if (screen === 'identity')
    return (
      <>
        <Header {...headerProps} />
        <main className="sg-center">
          <div className="sg-card" data-testid="sg-identity">
            <div className="sg-eyebrow">Identity check</div>
            <h1>Verify your identity to open this document</h1>
            <p className="sg-muted">
              The sender asked you to confirm who you are with a photo ID. Our verification partner checks the ID; Aramo Sign keeps only the result, never the ID itself.
            </p>
            {idMessage !== null && <p role="status">{idMessage}</p>}
            <Btn className="sg-btn--block" onClick={() => void startIdentityCheck()} disabled={busy}>
              Verify my identity
            </Btn>
            <Btn variant="quiet" className="sg-btn--block" onClick={() => void continueAfterIdentityCheck()} disabled={busy}>
              Continue
            </Btn>
          </div>
        </main>
      </>
    );
  if (screen === 'declined')
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="muted" title="You declined to sign" body="Your decision and your reason have been recorded, and the sender can see them. You can close this page." />
      </>
    );
  if (screen === 'done' && selfReturn !== null)
    return (
      <>
        <Header {...headerProps} />
        <EndState tone="ok" title="You signed" body="Your signed PDF and certificate are ready.">
          <a className="sg-btn sg-btn--primary" href={selfReturn} data-testid="self-sign-open-envelope">
            Open the envelope
          </a>
        </EndState>
      </>
    );
  if (screen === 'done')
    return (
      <>
        <Header {...headerProps} />
        <EndState
          tone="ok"
          title={title ? `You've signed ${title}` : "You've signed"}
          body={allSigned ? "Everyone has signed. We'll email you a link to download your signed copy." : "Your part is done. Others still need to sign; when everyone has, we'll email you a link to your signed copy."}
        >
          {view?.inbox_save_available === true ? <SaveToInbox token={token} /> : null}
        </EndState>
      </>
    );
  if (screen === 'network')
    return (
      <>
        <Header {...headerProps} />
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
        <Header {...headerProps} />
        <EndState tone="error" title="Something went wrong" body="We couldn't open this document. Try the link from your email again later, or contact the sender." />
      </>
    );
  if (screen === 'loading')
    return (
      <>
        <Header {...headerProps} />
        <main className="sg-center" aria-busy="true">
          <p className="sg-muted">Opening your document…</p>
        </main>
      </>
    );

  if (screen === 'landing')
    return (
      <>
        <Header {...headerProps} />
        <main className="sg-center">
          {selfSigning ? (
            // UAT SND-11 (A2-A3) — as the app's own Sign a document: you're the only signer.
            <div className="sg-card" data-testid="sg-landing-self">
              <div className="sg-eyebrow">Sign a document</div>
              <h1>Sign your document</h1>
              <p className="sg-muted">You&apos;re the only signer. Nobody is emailed.</p>
              <Btn className="sg-btn--block" onClick={() => setScreen('disclosure')}>
                Review document
              </Btn>
            </div>
          ) : (
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
              <p className="sg-muted sg-small sg-report-line">
                Don&apos;t know the sender? <ReportLink token={token} />
              </p>
            </div>
          )}
        </main>
        {declineOpen ? <DeclineDialog onDecline={decline} onClose={() => setDeclineOpen(false)} /> : null}
      </>
    );

  if (screen === 'disclosure')
    return (
      <>
        <Header {...headerProps} />
        <main className="sg-center">
          <div className="sg-card sg-card--wide" data-testid="sg-disclosure">
            <h1>Before you sign electronically</h1>
            <div className="sg-disclosure" tabIndex={0} aria-label="Electronic records and signature disclosure">
              <h2>Electronic records and signature disclosure</h2>
              {(disclosure?.text ?? '').split(/\n{2,}/).map((para, i) => (
                <p key={i} style={{ whiteSpace: 'pre-line' }}>
                  {para}
                </p>
              ))}
              <p className="sg-muted sg-small">Version {disclosure?.disclosure_version ?? ''}</p>
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
  const allDone = problem === null;
  const qesPending = qes !== null && qes.state !== 'SIGNED';

  return (
    <>
      <Header title={title} progress={progress} onDecline={selfSigning ? undefined : () => setDeclineOpen(true)} {...headerProps} />
      {screen === 'review' ? (
        <main className="sg-center">
          <div className="sg-card sg-card--wide" data-testid="sg-review">
            <h1>Review &amp; finish</h1>
            <ul className="sg-summary">
              {shownList.map((f) => (
                <li key={f.field_id}>
                  <span>
                    {fieldLabel(f)} · page {f.page_number + 1}
                  </span>
                  <span className={!pending(f) ? 'sg-ok' : 'sg-muted'}>{statusOf(f)}</span>
                </li>
              ))}
            </ul>
            {problem !== null ? (
              <p className="sg-error" role="alert" data-testid="sg-problem">
                {problem}
              </p>
            ) : null}
            {qesPending ? (
              <div className="sg-qes" data-testid="sg-qes">
                <h2>Qualified electronic signature</h2>
                <p className="sg-muted">
                  The sender asked for a qualified signature. You&apos;ll confirm who you are and sign with {qes?.provider ?? 'a trust service provider'}, then come back here to
                  finish.
                </p>
                {qes?.state === 'FAILED' ? (
                  <p className="sg-error" role="alert">
                    The last attempt didn&apos;t finish. You can try again.
                  </p>
                ) : null}
                {notice ? (
                  <p className="sg-error" role="alert">
                    {notice}
                  </p>
                ) : null}
                <Btn disabled={busy} onClick={() => void startQes()}>
                  {qes?.state === 'FAILED' ? 'Try again' : 'Continue to sign'}
                </Btn>
              </div>
            ) : null}
            {finishError ? (
              <p className="sg-error" role="alert">
                Finishing didn&apos;t go through. Your entries are kept — try again.
              </p>
            ) : null}
            <div className="sg-dialog__foot">
              <Btn
                variant="secondary"
                onClick={() => {
                  setScreen('workspace');
                  // FIELD-PARITY-1 P3 — with a rule unmet, back goes to the first field still to do.
                  if (problem !== null && nextField !== null) {
                    goTo(nextField);
                    setFocusId(nextField.field_id);
                  }
                }}
              >
                {problem !== null && nextField !== null ? 'Go to the field' : 'Back to document'}
              </Btn>
              <Btn disabled={busy || !allDone || qesPending} onClick={() => void finish()}>
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
                key={doc.document_id}
                base64={docB64[doc.document_id] ?? ''}
                loadTextLayer={() => signApi.textLayer(token, doc.document_id)}
                fields={shownList.filter((f) => f.document_id === doc.document_id)}
                display={displayOf}
                activeField={activeField}
                label={fieldLabel}
                locked={isLocked}
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
              <p className="sg-error" role="alert" id="sg-notice" tabIndex={-1}>
                {notice}
              </p>
            ) : null}
            <ul>
              {shownList.map((f) => {
                const done = !pending(f);
                if (isServerName(f)) {
                  return (
                    <li key={f.field_id} className="sg-field sg-field--done" data-testid="sg-server-name">
                      <span className="sg-field__text">
                        <span className="sg-field__name">Your name</span>
                        <span className="sg-field__meta">
                          {f.value ?? ''} · from the signing request
                        </span>
                      </span>
                    </li>
                  );
                }
                const help = signerFieldTooltip(f);
                const helpId = help !== null ? `sg-help-${f.field_id}` : undefined;
                const helpLine =
                  help !== null ? (
                    <span className="sg-field__meta" id={helpId} data-testid="sg-field-help">
                      {help}
                    </span>
                  ) : null;
                // FIELD-PARITY-1 P3 S-4 / S-5 — the sender's value: shown, never a button.
                if (isLocked(f)) {
                  const shown = displayOf(f);
                  return (
                    <li key={f.field_id} className="sg-field sg-field--done" data-testid="sg-sender-value">
                      <span className="sg-field__text">
                        <span className="sg-field__name">{fieldLabel(f)}</span>
                        <span className="sg-field__meta">
                          {shown?.kind === 'text' ? `${shown.value} · ` : shown?.kind === 'mark' ? (isRadio(f) ? 'Chosen · ' : 'Checked · ') : ''}
                          {SENDER_VALUE.toLowerCase()} · page {f.page_number + 1}
                        </span>
                        {helpLine}
                      </span>
                    </li>
                  );
                }
                if (isBox(f)) {
                  const on = isChecked(filled[f.field_id]);
                  const radio = isRadio(f);
                  const verb = radio ? (on ? 'Chosen' : 'Choose') : on ? 'Uncheck' : 'Check';
                  return (
                    <li key={f.field_id} className={`sg-field${on ? ' sg-field--done' : ''}${activeField === f.field_id ? ' sg-field--active' : ''}`}>
                      <span className="sg-field__text">
                        <span className="sg-field__name">{fieldLabel(f)}</span>
                        <span className="sg-field__meta">
                          page {f.page_number + 1}
                          {radio || f.group_rule === 'SELECT_ONE' ? ' · choose one' : typeof f.group_key === 'string' && f.group_key.length > 0 ? ' · choose any' : ''}
                          {f.required ? ' · required' : ' · optional'}
                        </span>
                        {helpLine}
                      </span>
                      <Btn
                        id={`sg-act-${f.field_id}`}
                        variant={on ? 'quiet' : f.required ? 'primary' : 'secondary'}
                        disabled={busy}
                        {...(radio ? { role: 'radio', 'aria-checked': on } : { 'aria-pressed': on })}
                        aria-describedby={helpId}
                        onClick={() => act(f)}
                        aria-label={`${verb}: ${fieldLabel(f)}, page ${f.page_number + 1}`}
                      >
                        {verb}
                      </Btn>
                    </li>
                  );
                }
                return (
                  <li key={f.field_id} className={`sg-field${done ? ' sg-field--done' : ''}${activeField === f.field_id ? ' sg-field--active' : ''}`}>
                    <span className="sg-field__text">
                      <span className="sg-field__name">{fieldLabel(f)}</span>
                      <span className="sg-field__meta">
                        {docs.length > 1 ? `${docs.find((d) => d.document_id === f.document_id)?.title ?? ''} · ` : ''}page {f.page_number + 1}
                        {f.required ? ' · required' : ' · optional'}
                        {f.field_type === 'SIGN_DATE' ? ` · ${SIGN_DATE_PREVIEW_NOTE}` : ''}
                      </span>
                      {helpLine}
                    </span>
                    {done ? (
                      <span className="sg-done-actions">
                        <span className="sg-ok">Filled</span>
                        {editable(f) ? (
                          <Btn id={`sg-act-${f.field_id}`} variant="quiet" disabled={busy} onClick={() => act(f)} aria-describedby={helpId} aria-label={`Change ${fieldLabel(f)}, page ${f.page_number + 1}`}>
                            Change
                          </Btn>
                        ) : null}
                      </span>
                    ) : (
                      <Btn
                        id={`sg-act-${f.field_id}`}
                        variant={f.required ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() => act(f)}
                        aria-describedby={helpId}
                        aria-label={`${ACTION_LABEL[f.field_type] ?? 'Complete'}: ${fieldLabel(f)}, page ${f.page_number + 1}`}
                      >
                        {ACTION_LABEL[f.field_type] ?? 'Complete'}
                      </Btn>
                    )}
                  </li>
                );
              })}
            </ul>
            {view?.can_delegate === true ? (
              <Btn variant="quiet" disabled={busy} onClick={() => setDelegateOpen(true)} data-testid="sg-delegate">
                Ask someone else to sign
              </Btn>
            ) : null}
          </aside>
          <div className="sg-bar">
            <div className="sg-progress" aria-hidden="true">
              <span style={{ width: `${required.length === 0 ? 100 : Math.round((doneRequired / required.length) * 100)}%` }} />
            </div>
            <span className="sg-small">{progress}</span>
            {allDone ? (
              <Btn onClick={() => setScreen('review')}>Review &amp; finish</Btn>
            ) : nextField === null && problem !== null ? (
              <span className="sg-small sg-error" role="status" data-testid="sg-problem">
                {problem}
              </span>
            ) : (
              <Btn disabled={busy || nextField === null} onClick={() => nextField && (isBox(nextField) ? focusOn(nextField) : act(nextField))}>
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
          saved={(adoptFor.field_type === 'INITIALS' ? savedMarks?.initials : savedMarks?.signature) ?? null}
          canSave={savedMarks?.can_save === true}
          onAdopt={(a, saveDefault) => {
            const f = adoptFor;
            const kind = f.field_type === 'INITIALS' ? 'INITIALS' : 'SIGNATURE';
            setAdopted((m) => ({ ...m, [kind]: a }));
            setAdoptFor(null);
            void fill(f, a.value, a.method);
            if (saveDefault) void saveAsDefault(kind, a);
          }}
        />
      ) : null}
      {textFor ? (
        <FieldDialog
          field={textFor}
          title={fieldLabel(textFor)}
          dateFormat={view?.date_format ?? null}
          initial={typedIn(textFor) !== '' ? typedIn(textFor) : textFor.field_type === 'SIGNER_NAME' && !isServerName(textFor) ? suggestedName : ''}
          onClose={() => setTextFor(null)}
          onSave={async (v) => {
            const f = textFor;
            const r = await save(f, v);
            // A refused value stays in the editor with its message; anything else closes it.
            if (!r.ok && r.message !== null) return r.message;
            setTextFor(null);
            return null;
          }}
        />
      ) : null}
      {declineOpen ? <DeclineDialog onDecline={decline} onClose={() => setDeclineOpen(false)} /> : null}
      {delegateOpen ? <DelegateDialog onDelegate={delegate} onClose={() => setDelegateOpen(false)} /> : null}
    </>
  );
}
