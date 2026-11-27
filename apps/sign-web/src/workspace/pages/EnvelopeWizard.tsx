import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Input } from '@aramo/fe-foundation';
import {
  EMAIL_CODE_OPTION,
  PDF_PICKER_TYPES,
  PHONE_STEP_UP_REASON,
  REFUSAL_COPY,
  SIGNERS_FULL_MESSAGE,
  offersPhoneStepUp,
  type PhoneStepUpStatus,
  checkPickedFile,
  danglingWitness,
  isWitnessable,
  isValidEmail,
  roleLabel as sharedRoleLabel,
  sendFeaturesOf,
  templateAccess,
  titleFromFilename,
  SIGN_SUBJECT_PREFIX,
  AUTO_REMINDER_COPY,
} from '@aramo/sign-client';

import {
  E164_RE,
  ENVELOPE_MESSAGE_MAX,
  ENVELOPE_SUBJECT_MAX,
  fetchSourcePdf,
  SUBJECT_LIMIT_NOTE,
  errorMessage,
  fileToBase64,
  isAllowanceLimit,
  isCopyRecipient,
  MAX_COPY_RECIPIENTS,
  MAX_SIGNERS,
  refusalReason,
  senderApi,
  stepUpApi,
  type ContactRow,
  type CopyDelivery,
  type DeliveryChannel,
  type EnvelopeDetail,
  type IdentityVerificationMethod,
  type RecipientKind,
  type RecipientMessaging,
  type RoutingMode,
  validAccessCode,
} from '../api';
import { Area, Avatar, Btn, COLORS, ErrorBox, Field, Icon, LinkBtn, Loading, RecipientPill, Sel, TextIn, fmtBytes } from '../ui';
import { useWorkspace } from '../workspace';

import { selfSignRefusal } from './EnvelopeDetail';
import { PersonalUpgradeLink } from './PersonalAllowance';
import { PhoneStepUpPanel } from './PhoneStepUp';
import { PrepareEditor } from './PrepareEditor';
import { readinessOf } from './readiness';

// Create envelope — 4 steps (prototype): 1 Documents · 2 Recipients · 3 Prepare
// fields · 4 Review & send. DRAFT only: a sent or terminal envelope never opens
// the wizard or the editor (falls through to the read-only detail).

// Client Rule Consolidation C3 (audit row 25) — the file check is @aramo/sign-client's
// checkPickedFile (leading bytes, 25 MB). Word upload stays an Aramo Sign app feature
// (C4 parity record), so the web never allows Word here.
async function headOf(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.slice(0, 1024).arrayBuffer());
}


// Web Self-Signing A2 — `mode="self"` is "Sign a document": a SELF draft (the caller is the
// only signer; no email, no allowance used) that opens the same wizard.
/** UAT SND-24 — Contacts "Send to": the person to add as the first signer (`?to=&name=`). */
export function sendToFrom(search: string): { name: string; email: string } | null {
  const p = new URLSearchParams(search);
  const email = (p.get('to') ?? '').trim();
  // C3 (audit row 22) — the server's email rule (@aramo/sign-client).
  if (!isValidEmail(email)) return null;
  const name = (p.get('name') ?? '').trim().slice(0, 200) || email;
  return { name, email };
}

export function NewEnvelope({ mode = 'standard' }: { mode?: 'standard' | 'self' } = {}) {
  const { base, ctx } = useWorkspace();
  const nav = useNavigate();
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !ctx.can_send) return;
    started.current = true;
    const to = mode === 'standard' ? sendToFrom(window.location.search) : null;
    senderApi
      .create(undefined, mode)
      .then(async (e) => {
        // Send to — the contact is the first signer (the draft still opens at Documents).
        if (to !== null) await senderApi.recipients(e.id, [{ name: to.name, email: to.email, recipient_kind: 'SIGNER' }]);
        nav(`${base}/envelopes/${e.id}/edit?step=1`, { replace: true });
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [base, nav, ctx.can_send, mode]);
  if (!ctx.can_send) return <Navigate to={`${base}/envelopes`} replace />;
  return <div className="sg-page">{error !== '' ? <ErrorBox>{error}</ErrorBox> : <Loading label={mode === 'self' ? 'Starting…' : 'Creating envelope…'} />}</div>;
}

export function EnvelopeWizard({ prepare = false }: { prepare?: boolean }) {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { base, ctx, refreshCounts } = useWorkspace();
  const [env, setEnv] = useState<EnvelopeDetail | null>(null);
  const [error, setError] = useState('');
  const step = prepare ? 3 : Math.min(4, Math.max(1, Number(params.get('step') ?? '1') || 1));

  const load = useCallback(() => {
    senderApi
      .detail(id)
      .then((d) => {
        setEnv(d);
        setError('');
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  if (error !== '' && env === null)
    return (
      <div className="sg-page">
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  if (env === null) return <Loading />;
  // End-state / sent envelopes never reopen the wizard or the editor.
  if (env.status !== 'DRAFT' || !ctx.can_send) return <Navigate to={`${base}/envelopes/${env.id}`} replace />;

  const stepHref = (n: number) => `${base}/envelopes/${env.id}/${n === 3 ? 'prepare' : `edit?step=${n}`}`;
  // Web Self-Signing A2 — a SELF envelope: Document → Place fields → Sign (no Recipients step;
  // the caller is the only signer).
  const self = env.mode === 'self';
  if (self && step === 2) return <Navigate to={stepHref(3)} replace />;
  const steps = self ? ['Document', 'Place fields', 'Sign'] : ['Documents', 'Recipients', 'Prepare fields', 'Review & send'];
  const stepNumbers = self ? [1, 3, 4] : [1, 2, 3, 4];

  return (
    <div className={step === 3 ? 'sg-page sg-page--wide' : 'sg-page sg-page--wide'}>
      <Link className="sg-back" to={`${base}/envelopes`}>
        <Icon name="back" size={14} /> Envelopes
      </Link>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="sg-h1">{env.subject}</h1>
        <span className="sg-mono sg-faint" style={{ fontSize: 12 }}>
          {env.id.slice(0, 8)} · Draft · saved automatically
        </span>
      </div>
      <nav className="sg-steps" aria-label="Create envelope steps">
        {steps.map((label, i) => {
          const n = stepNumbers[i] ?? i + 1;
          const cls = n === step ? 'sg-step sg-step--on' : n < step ? 'sg-step sg-step--done' : 'sg-step';
          return (
            <Link key={label} className={cls} to={stepHref(n)} aria-current={n === step ? 'step' : undefined}>
              <span className="sg-step__n">{i + 1}</span>
              {label}
            </Link>
          );
        })}
      </nav>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {step === 1 ? <DocumentsStep env={env} onChange={setEnv} next={stepHref(self ? 3 : 2)} /> : null}
      {step === 2 && !self ? <RecipientsStep env={env} onChange={setEnv} back={stepHref(1)} next={stepHref(3)} /> : null}
      {step === 3 ? <PrepareEditor env={env} onChange={setEnv} back={stepHref(self ? 1 : 2)} next={stepHref(4)} /> : null}
      {step === 4 && !self ? <ReviewStep env={env} back={stepHref(3)} onSent={refreshCounts} /> : null}
      {step === 4 && self ? <SelfSignStep env={env} back={stepHref(3)} onSent={refreshCounts} /> : null}
    </div>
  );
}

// ── Step 1 · Documents ───────────────────────────────────────────────────────

function DocumentsStep({ env, onChange, next }: { env: EnvelopeDetail; onChange: (d: EnvelopeDetail) => void; next: string }) {
  const { base, ctx } = useWorkspace();
  // Web Self-Signing A2 §6 — templates are not offered for a document the sender signs alone.
  // C3 (audit row 14) — the one templates-access rule (@aramo/sign-client).
  const templatesUsable = templateAccess(ctx, 'use') === 'ok' && env.mode !== 'self';
  const nav = useNavigate();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});
  // PO ruling 2026-11-25 — the FIELD-PARITY-1 P2-5 / P2-6 upload options ("Import fields from a
  // fillable PDF", "Apply text tags") are for authoring Document templates (the console form
  // Studio), not for sending: the Send wizard uploads without them, as the app does.

  const upload = async (files: FileList | File[]) => {
    setError('');
    for (const f of Array.from(files)) {
      const check = checkPickedFile({ name: f.name, mimeType: f.type, size: f.size, head: await headOf(f), wordAllowed: false });
      if (!check.ok) {
        setError(`${f.name}: ${check.message}`);
        continue;
      }
      setBusy(`Uploading ${f.name}…`);
      try {
        const content_base64 = await fileToBase64(f);
        await senderApi.upload(env.id, { filename: f.name, title: titleFromFilename(f.name), content_base64 });
      } catch (e) {
        setError(errorMessage(e));
      }
    }
    setBusy('');
    let d = await senderApi.detail(env.id);
    // Prototype: an untitled envelope takes its first document's title.
    const first = d.documents[0];
    if (d.subject === 'Untitled envelope' && first !== undefined) d = await senderApi.rename(env.id, first.title);
    onChange(d);
  };

  const act = async (fn: () => Promise<EnvelopeDetail>) => {
    setError('');
    try {
      onChange(await fn());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
  };

  return (
    <>
      <div className="sg-grid sg-grid--main">
        <div>
          <label
            className={over ? 'sg-drop sg-drop--over' : 'sg-drop'}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            data-testid="drop-zone"
          >
            <Input
              unstyled
              type="file"
              accept={[...PDF_PICKER_TYPES, '.pdf'].join(',')}
              multiple
              style={{ display: 'none' }}
              aria-label="Upload PDF documents"
              onChange={(e) => {
                if (e.target.files !== null) void upload(e.target.files);
                e.target.value = '';
              }}
            />
            <div style={{ fontSize: 22, color: 'var(--muted)' }}>
              <Icon name="upload" size={26} />
            </div>
            <div style={{ fontWeight: 600, marginTop: 6 }}>Drop PDFs here or click to upload</div>
            <div className="sg-muted">PDF files up to 25 MB each</div>
          </label>
          {/* DOC-TEMPLATE-LIB-1 T-5 — start from one of the organization's document templates
              (shown only when the plan capability and the template permission allow it). */}
          {templatesUsable ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <Btn onClick={() => nav(`${base}/templates`)} data-testid="use-a-template">
                Use a template
              </Btn>
            </div>
          ) : null}
          {busy !== '' ? (
            <p className="sg-muted" role="status">
              {busy}
            </p>
          ) : null}
          {error !== '' ? (
            <div style={{ marginTop: 10 }}>
              <ErrorBox>{error}</ErrorBox>
            </div>
          ) : null}
        </div>
        <section className="sg-card">
          <div className="sg-card__head">
            Documents in this envelope <span className="sg-muted">· {env.documents.length}</span>
          </div>
          {env.documents.length === 0 ? <div className="sg-empty">No documents yet.</div> : null}
          {env.documents.map((d, i) => (
            <div key={d.id} className="sg-docrow" data-testid={`doc-${d.id}`}>
              <span className="sg-docicon" aria-hidden="true" />
              <TextIn
                aria-label={`Title for document ${i + 1}`}
                value={titles[d.id] ?? d.title}
                onChange={(e) => setTitles((t) => ({ ...t, [d.id]: e.target.value }))}
                onBlur={() => {
                  const t = (titles[d.id] ?? d.title).trim();
                  if (t !== '' && t !== d.title) void act(() => senderApi.renameDocument(env.id, d.id, t));
                }}
                style={{ border: 0, padding: 0, fontWeight: 600, background: 'transparent', flex: 1 }}
              />
              <span className="sg-muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                {fmtBytes(d.byte_size)}
              </span>
              {/* PO 2026-11-18 (DocuSign comparison) — check the uploaded file before going on: it
                  opens in a new tab (every page, the browser's viewer); the wizard is untouched. */}
              <Btn size="sm" variant="ghost" aria-label={`Preview ${d.title}`} onClick={() => void previewDocument(env.id, d.id, setError)} data-testid={`preview-${d.id}`}>
                Preview
              </Btn>
              <Btn
                size="sm"
                aria-label={`Move ${d.title} up`}
                disabled={i === 0}
                onClick={() => {
                  const o = env.documents.map((x) => x.id);
                  [o[i - 1], o[i]] = [o[i] as string, o[i - 1] as string];
                  void act(() => senderApi.reorderDocuments(env.id, o));
                }}
              >
                <Icon name="up" size={14} />
              </Btn>
              <Btn
                size="sm"
                aria-label={`Move ${d.title} down`}
                disabled={i === env.documents.length - 1}
                onClick={() => {
                  const o = env.documents.map((x) => x.id);
                  [o[i + 1], o[i]] = [o[i] as string, o[i + 1] as string];
                  void act(() => senderApi.reorderDocuments(env.id, o));
                }}
              >
                <Icon name="down" size={14} />
              </Btn>
              <Btn size="sm" variant="danger" aria-label={`Remove ${d.title}`} onClick={() => void act(() => senderApi.removeDocument(env.id, d.id))}>
                <Icon name="x" size={14} />
              </Btn>
            </div>
          ))}
        </section>
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(`${base}/envelopes`)}>Cancel</Btn>
        <Btn variant="primary" onClick={() => nav(next)} disabled={busy !== ''}>
          Continue <Icon name="next" size={14} />
        </Btn>
      </div>
    </>
  );
}

// ── Step 2 · Recipients ──────────────────────────────────────────────────────

interface DraftRecipient {
  key: string;
  id?: string;
  name: string;
  email: string;
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1 / §2 / §4 — the role, the copy timing
  // and Assign to me as saved on the server. A signer whose email is the caller's account
  // email is assigned automatically (Web Self-Signing directive W1); the server binds only
  // the caller's verified account email.
  kind: RecipientKind;
  copy: CopyDelivery;
  assign: boolean;
  // Amendment M-A6 §3.5 — the template role this recipient fills (from-template), if any.
  role_key?: string | null;
  // Consolidated Directive B2 — the signer a WITNESS attests for (a recipient key).
  witnessFor: string | null;
  // B2 / §1.9 — the server has an access code for this recipient; `accessCode` is the
  // pending change: undefined = keep, null = remove, a string = set (never stored here after save).
  accessCodeSet: boolean;
  accessCode?: string | null;
  // B2 / §1.9 — the identity check (null = none).
  idv: IdentityVerificationMethod | null;
  // SIGN-FREE-PARITY-1 S3 — ask for a code sent to the recipient's email before signing.
  emailOtp: boolean;
  // B2 / §1.7–§1.9 — the text-message choices; undefined = as saved on the server.
  msg?: Msg;
}

// B2 — one recipient's text-message choices as the step edits them.
interface Msg {
  channel: DeliveryChannel | null;
  otp: boolean;
  phone: string;
}
const NO_MSG: Msg = { channel: null, otp: false, phone: '' };
const sameMsg = (a: Msg, b: Msg) => a.channel === b.channel && a.otp === b.otp && (a.phone.trim() === b.phone.trim() || (a.channel === null && !a.otp));
const msgOf = (m: RecipientMessaging | undefined): Msg => (m === undefined ? NO_MSG : { channel: m.delivery_channel, otp: m.sms_otp_required, phone: m.phone_e164 ?? '' });

// B2 — who can carry each per-recipient choice (mirrors the server's checks).
const signsByLink = (k: RecipientKind) => k === 'SIGNER' || k === 'WITNESS';
// A recipient who signs (and so may be witnessed): @aramo/sign-client's one rule.
const isSigning = (k: RecipientKind) => isWitnessable(k);
const IDV_LABEL: Record<IdentityVerificationMethod, string> = { ID_VERIFICATION: 'Photo ID check', KBA: 'Identity questions (US)' };
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

// M-A5 §6.2 — the web Role select. In person is offered only once web hosting exists
// (not in this release); an in-person signer added from the app is kept as it is.
const COPY_TIMING_LABEL: Record<CopyDelivery, string> = {
  ON_SEND: 'When sent',
  ON_COMPLETION: 'When completed',
  BOTH: 'When sent and when completed',
};

// C3 (audit row 30) — the one set of role labels (@aramo/sign-client).
function roleLabel(kind: RecipientKind | undefined): string {
  return sharedRoleLabel(kind);
}

// "client_signer" → "Client signer" (the role key the server bound; display only).
function templateRoleLabel(roleKey: string): string {
  const t = roleKey.replace(/_+/g, ' ').trim();
  return t.length === 0 ? roleKey : t.charAt(0).toUpperCase() + t.slice(1);
}

function RecipientsStep({ env, onChange, back, next }: { env: EnvelopeDetail; onChange: (d: EnvelopeDetail) => void; back: string; next: string }) {
  const { ctx } = useWorkspace();
  const nav = useNavigate();
  const toDraft = (r: EnvelopeDetail['recipients'][number]): DraftRecipient => ({
    key: r.id,
    id: r.id,
    name: r.name,
    email: r.email ?? '',
    kind: r.recipient_kind ?? 'SIGNER',
    copy: r.copy_delivery ?? 'ON_COMPLETION',
    assign: r.assigned_to_me === true,
    role_key: r.role_key ?? null,
    witnessFor: r.recipient_kind === 'WITNESS' ? (r.witness_for_signer_id ?? null) : null,
    accessCodeSet: r.access_code_set === true,
    idv: r.identity_verification_method ?? null,
    emailOtp: r.email_otp_required === true,
  });
  const [list, setList] = useState<DraftRecipient[]>(() => env.recipients.map(toDraft));
  // Consolidated Directive B2 — each control shows only while the sender context reports it available.
  // C3 (audit row 15) — the per-recipient options from the sender context (@aramo/sign-client).
  const options = sendFeaturesOf(ctx);
  const messagingOn = options.sms || options.whatsapp || options.smsCode;
  const [allowDelegation, setAllowDelegation] = useState(env.allow_delegation === true);
  // SIGN-FREE-PARITY-1 S4 — automatic reminders (default on; all plans).
  const [autoReminders, setAutoReminders] = useState(env.auto_reminders?.enabled !== false);
  // The text-message choices saved on the server, by recipient id (read only when available).
  const [msgSaved, setMsgSaved] = useState<Record<string, Msg>>({});
  useEffect(() => {
    if (!messagingOn) return;
    senderApi
      .messaging(env.id)
      .then((r) => setMsgSaved(Object.fromEntries(r.recipients.map((m) => [m.signer_id, msgOf(m)]))))
      .catch(() => setMsgSaved({}));
  }, [env.id, messagingOn]);
  const msgFor = (r: DraftRecipient): Msg => r.msg ?? (r.id !== undefined ? (msgSaved[r.id] ?? NO_MSG) : NO_MSG);
  const msgDirty = (r: DraftRecipient): boolean => {
    const was = r.id !== undefined ? (msgSaved[r.id] ?? NO_MSG) : NO_MSG;
    const want = r.kind === 'SIGNER' ? msgFor(r) : NO_MSG;
    return !sameMsg(want, was);
  };
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  // UAT (contacts) — every contact is reachable, as in the app: a search and the full list
  // (it scrolls inside the card), instead of the first eight only.
  const [contactQuery, setContactQuery] = useState('');
  const shownContacts = filterContactRows(contacts, contactQuery);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Multi-Signer §5 — Sign in any order (PARALLEL) or Sign in order (SEQUENTIAL).
  const [routing, setRouting] = useState<RoutingMode>(env.routing_mode ?? 'PARALLEL');
  useEffect(() => {
    senderApi
      .contacts()
      .then((r) => setContacts(r.items))
      .catch(() => setContacts([]));
  }, []);

  const keyGen = useRef(0);
  // C3 (audit row 20, Appendix A) — the 11th signer is refused, never turned into a copy
  // recipient; a copy recipient is added on purpose (Add someone who receives a copy).
  const add = (name = '', email = '', assign = false, kind: RecipientKind = 'SIGNER') => {
    const signers = list.filter((r) => r.kind !== 'RECEIVES_COPY').length;
    if (kind !== 'RECEIVES_COPY' && signers >= MAX_SIGNERS) {
      setError(SIGNERS_FULL_MESSAGE);
      return;
    }
    setError('');
    setList((l) => [...l, { key: `new-${(keyGen.current += 1)}`, name, email, kind, copy: 'ON_COMPLETION', assign: assign && kind === 'SIGNER', witnessFor: null, accessCodeSet: false, idv: null, emailOtp: false }]);
  };
  const myEmail = ctx.user.email?.trim().toLowerCase() ?? '';
  const isMine = (email: string) => myEmail !== '' && email.trim().toLowerCase() === myEmail;
  const upd = (key: string, patch: Partial<DraftRecipient>) => setList((l) => l.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // B2 — a role change keeps the per-recipient choices consistent with the new role: a witness
  // names a signer; a recipient who no longer signs is no longer witnessed.
  const setKind = (key: string, kind: RecipientKind) =>
    setList((l) => {
      const firstSigner = l.find((x) => x.key !== key && isSigning(x.kind))?.key ?? null;
      return l.map((r) => {
        if (r.key === key) {
          return {
            ...r,
            kind,
            ...(kind === 'RECEIVES_COPY' || kind === 'WITNESS' ? { assign: false } : {}),
            witnessFor: kind === 'WITNESS' ? (r.witnessFor ?? firstSigner) : null,
            ...(signsByLink(kind) ? {} : { accessCode: r.accessCodeSet ? null : undefined, idv: null, emailOtp: false }),
          };
        }
        return !isSigning(kind) && r.witnessFor === key ? { ...r, witnessFor: null } : r;
      });
    });
  const remove = (key: string) => setList((l) => l.filter((x) => x.key !== key).map((x) => (x.witnessFor === key ? { ...x, witnessFor: null } : x)));
  const move = (key: string, by: -1 | 1) =>
    setList((l) => {
      const i = l.findIndex((r) => r.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= l.length) return l;
      const copy = [...l];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
  const listDirty =
    list.length !== env.recipients.length ||
    list.some((r, i) => {
      const was = env.recipients[i] === undefined ? undefined : toDraft(env.recipients[i]!);
      return (
        was === undefined ||
        r.id !== was.id ||
        r.name !== was.name ||
        r.email !== was.email ||
        r.kind !== was.kind ||
        (r.kind === 'RECEIVES_COPY' && r.copy !== was.copy) ||
        (r.kind === 'SIGNER' && isMine(r.email)) !== was.assign ||
        r.witnessFor !== was.witnessFor ||
        r.idv !== was.idv ||
        r.emailOtp !== was.emailOtp ||
        r.accessCode !== undefined
      );
    });
  const routingDirty = routing !== (env.routing_mode ?? 'PARALLEL');
  const delegationDirty = allowDelegation !== (env.allow_delegation === true);
  const autoRemindersDirty = env.auto_reminders !== undefined && autoReminders !== env.auto_reminders.enabled;
  const anyMsgDirty = list.some(msgDirty);
  const duplicate = (() => {
    const seen = new Set<string>();
    for (const r of list) {
      const k = r.email.trim().toLowerCase();
      if (k === '') continue;
      if (seen.has(k)) return r.email.trim();
      seen.add(k);
    }
    return null;
  })();

  // B2 — the first problem the server would refuse, said plainly before saving.
  const choiceProblem = (): string | null => {
    for (const [i, r] of list.entries()) {
      const who = r.name.trim() || r.email.trim() || `Recipient ${i + 1}`;
      // C3 (audit row 31) — the one witness rule (@aramo/sign-client).
      if (danglingWitness([r, ...list.filter((x) => x.key !== r.key)])?.key === r.key) return `Choose the signer ${who} witnesses.`;
      if (typeof r.accessCode === 'string' && !validAccessCode(r.accessCode)) return `The access code for ${who} must be 4 to 32 characters (letters, numbers or symbols).`;
      const m = msgFor(r);
      if (r.kind === 'SIGNER' && (m.channel !== null || m.otp) && !E164_RE.test(m.phone.trim()))
        return `Enter the mobile number for ${who} in international format, for example +14155550123.`;
    }
    return null;
  };

  const save = async (to: string) => {
    setError('');
    if (!listDirty && !routingDirty && !delegationDirty && !autoRemindersDirty && !anyMsgDirty) {
      nav(to);
      return;
    }
    if (duplicate !== null) {
      setError(`${duplicate} is on this envelope twice. Each signer needs their own email address.`);
      return;
    }
    const problem = choiceProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      let d = env;
      if (routingDirty) d = await senderApi.setRouting(env.id, routing);
      if (delegationDirty) d = await senderApi.setAllowDelegation(env.id, allowDelegation);
      if (autoRemindersDirty) d = await senderApi.setAutoReminders(env.id, autoReminders);
      if (listDirty) {
        const index = new Map(list.map((r, i) => [r.key, i]));
        d = await senderApi.recipients(
          env.id,
          list.map((r) => ({
            ...(r.id !== undefined ? { id: r.id } : {}),
            name: r.name.trim(),
            email: r.kind === 'IN_PERSON_SIGNER' && r.email.trim() === '' ? null : r.email.trim(),
            recipient_kind: r.kind,
            copy_delivery: r.kind === 'RECEIVES_COPY' ? r.copy : null,
            // M-A5 §4.1 — automatic for the signed-in user's own email (W1); the server re-checks it.
            ...(r.kind === 'SIGNER' && isMine(r.email) ? { assign_to_me: true } : {}),
            // B2 — a witness names its signer by list position.
            ...(r.kind === 'WITNESS' ? { witness_for_index: r.witnessFor === null ? null : (index.get(r.witnessFor) ?? null) } : {}),
            // B2 / §1.9 — sent only when changed: a string sets, null removes, omitted keeps.
            ...(r.accessCode !== undefined ? { access_code: r.accessCode === null ? null : r.accessCode.trim() } : {}),
            ...(r.idv !== (r.id !== undefined ? (env.recipients.find((x) => x.id === r.id)?.identity_verification_method ?? null) : null)
              ? { identity_verification_method: signsByLink(r.kind) ? r.idv : null }
              : {}),
            // SIGN-FREE-PARITY-1 S3 — the email code, sent only when changed (omitted keeps it).
            ...(signsByLink(r.kind) && r.emailOtp !== (r.id !== undefined ? env.recipients.find((x) => x.id === r.id)?.email_otp_required === true : false)
              ? { email_otp_required: r.emailOtp }
              : {}),
          })),
        );
      }
      // B2 — text-message choices are saved per recipient once the recipient has a server id.
      for (const r of list.filter(msgDirty)) {
        const id = r.id ?? d.recipients.find((x) => (x.email ?? '').toLowerCase() === r.email.trim().toLowerCase())?.id;
        if (id === undefined) continue;
        const m = r.kind === 'SIGNER' ? msgFor(r) : NO_MSG;
        await senderApi.setMessaging(env.id, id, {
          delivery_channel: m.channel,
          sms_otp_required: m.otp,
          ...(m.channel !== null || m.otp ? { phone_e164: m.phone.trim() } : {}),
        });
      }
      onChange(d);
      nav(to);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const fieldCounts = (id?: string) => {
    const f = env.fields.filter((x) => x.signer_id === id);
    return `${f.filter((x) => x.required).length} required · ${f.filter((x) => !x.required).length} optional`;
  };
  const inList = (email: string) => list.some((r) => r.email.trim().toLowerCase() === email.toLowerCase());
  // Multi-Signer M-2 — up to MAX_SIGNERS signers per envelope; M-A5 §1.4 — and up to
  // MAX_COPY_RECIPIENTS copy recipients.
  const signerCount = list.filter((r) => r.kind !== 'RECEIVES_COPY').length;
  const copyCount = list.length - signerCount;
  const full = signerCount >= MAX_SIGNERS && copyCount >= MAX_COPY_RECIPIENTS;
  const ordered = routing === 'SEQUENTIAL';

  return (
    <>
      <div className="sg-grid sg-grid--main">
        <div>
          <section className="sg-card" style={{ marginBottom: 12 }}>
            <div className="sg-card__body">
              <div className="sg-label">Signing order</div>
              <div role="radiogroup" aria-label="Signing order" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Input unstyled type="radio" name="routing" checked={!ordered} onChange={() => setRouting('PARALLEL')} data-testid="routing-parallel" />
                  Sign in any order
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Input unstyled type="radio" name="routing" checked={ordered} onChange={() => setRouting('SEQUENTIAL')} data-testid="routing-sequential" />
                  Sign in order
                </label>
              </div>
              <p className="sg-muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
                {ordered
                  ? 'Each signer gets the document after the person before them signs, in the order shown below.'
                  : 'Everyone gets the document now and can sign at any time.'}
              </p>
              {/* B2 / Feature-Parity §1.17 — delegate signing (Business; shown only while available). */}
              {options.delegation || env.allow_delegation === true ? (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
                  <Input
                    unstyled
                    type="checkbox"
                    checked={allowDelegation}
                    onChange={(e) => setAllowDelegation(e.target.checked)}
                    data-testid="allow-delegation"
                  />
                  Let signers hand off to someone else
                </label>
              ) : null}
              {allowDelegation ? (
                <p className="sg-muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                  A signer can pass their part to another person, who signs in their own name. The hand-off is recorded.
                </p>
              ) : null}
              {/* SIGN-FREE-PARITY-1 S4 — automatic reminders (all plans; shown once the server reports them). */}
              {env.auto_reminders !== undefined && env.mode !== 'self' ? (
                <>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
                    <Input
                      unstyled
                      type="checkbox"
                      checked={autoReminders}
                      onChange={(e) => setAutoReminders(e.target.checked)}
                      data-testid="auto-reminders"
                    />
                    {AUTO_REMINDER_COPY.label}
                  </label>
                  <p className="sg-muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                    {AUTO_REMINDER_COPY.help}
                  </p>
                </>
              ) : null}
            </div>
          </section>
          {list.length === 0 ? <div className="sg-card sg-empty">No recipients yet. Add the people who need to sign.</div> : null}
          {list.map((r, i) => (
            <section key={r.key} className="sg-card sg-recipient" style={{ borderLeftColor: COLORS[i % COLORS.length], marginBottom: 12 }} data-testid="recipient-card">
              <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
                <div className="sg-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  <Field label="Name" htmlFor={`rn-${r.key}`}>
                    <TextIn id={`rn-${r.key}`} value={r.name} onChange={(e) => upd(r.key, { name: e.target.value })} />
                  </Field>
                  <Field label="Email" htmlFor={`re-${r.key}`}>
                    {/* UAT SEC-09 (web ≡ app) — an "Assign to me" row keeps the account's email: it
                        cannot be edited to someone else's. Remove the row to send to another person. */}
                    <TextIn
                      id={`re-${r.key}`}
                      type="email"
                      value={r.email}
                      readOnly={r.assign}
                      aria-readonly={r.assign}
                      onChange={(e) => {
                        if (!r.assign) upd(r.key, { email: e.target.value });
                      }}
                      data-testid="recipient-email"
                    />
                  </Field>
                  <Field label="Role" htmlFor={`rr-${r.key}`}>
                    <Sel id={`rr-${r.key}`} value={r.kind} onChange={(e) => setKind(r.key, e.target.value as RecipientKind)} data-testid="recipient-role">
                      <option value="SIGNER" disabled={r.kind !== 'SIGNER' && signerCount >= MAX_SIGNERS}>
                        {roleLabel('SIGNER')}
                      </option>
                      <option value="RECEIVES_COPY" disabled={r.kind !== 'RECEIVES_COPY' && copyCount >= MAX_COPY_RECIPIENTS}>
                        {roleLabel('RECEIVES_COPY')}
                      </option>
                      {r.kind === 'IN_PERSON_SIGNER' ? <option value="IN_PERSON_SIGNER">{roleLabel('IN_PERSON_SIGNER')} (Aramo Sign app)</option> : null}
                      {options.witness || r.kind === 'WITNESS' ? (
                        <option value="WITNESS" disabled={r.kind !== 'WITNESS' && (signerCount >= MAX_SIGNERS || !list.some((x) => x.key !== r.key && isSigning(x.kind)))}>
                          {roleLabel('WITNESS')}
                        </option>
                      ) : null}
                    </Sel>
                  </Field>
                </div>
                {r.kind === 'WITNESS' ? (
                  <Field label="Witnesses" htmlFor={`rw-${r.key}`} help="The witness signs after this signer to confirm they saw them sign.">
                    <Sel id={`rw-${r.key}`} value={r.witnessFor ?? ''} onChange={(e) => upd(r.key, { witnessFor: e.target.value === '' ? null : e.target.value })} data-testid="witness-for">
                      <option value="">Choose a signer</option>
                      {list
                        .filter((x) => x.key !== r.key && isSigning(x.kind))
                        .map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.name.trim() || x.email.trim() || 'Unnamed signer'}
                          </option>
                        ))}
                    </Sel>
                  </Field>
                ) : null}
                {r.kind === 'RECEIVES_COPY' ? (
                  <Field label="Send the copy" htmlFor={`rc-${r.key}`}>
                    <Sel id={`rc-${r.key}`} value={r.copy} onChange={(e) => upd(r.key, { copy: e.target.value as CopyDelivery })} data-testid="copy-timing">
                      {(Object.keys(COPY_TIMING_LABEL) as CopyDelivery[]).map((k) => (
                        <option key={k} value={k}>
                          {COPY_TIMING_LABEL[k]}
                        </option>
                      ))}
                    </Sel>
                  </Field>
                ) : null}
                {r.kind === 'SIGNER' && (r.assign || isMine(r.email)) ? (
                  <div className="sg-row__s" data-testid="assign-to-me">
                    This is you. After sending, sign from the envelope page with Sign now, or use the emailed link.
                    {r.assign ? ' Your email can’t be changed here. To send to someone else, remove this recipient and add them.' : ''}
                  </div>
                ) : null}
                <div className="sg-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
                  {/* B2 / §1.9 — the identity check (Business; each method only while available). */}
                  <Field label="Verification" htmlFor={`rv-${r.key}`}>
                    <Sel
                      id={`rv-${r.key}`}
                      value={signsByLink(r.kind) ? (r.idv ?? '') : ''}
                      disabled={!signsByLink(r.kind) || (!options.idCheck && !options.kba && r.idv === null)}
                      onChange={(e) => upd(r.key, { idv: e.target.value === '' ? null : (e.target.value as IdentityVerificationMethod) })}
                      data-testid="identity-check"
                    >
                      <option value="">Secure link</option>
                      {options.idCheck || r.idv === 'ID_VERIFICATION' ? <option value="ID_VERIFICATION">Secure link + {lowerFirst(IDV_LABEL.ID_VERIFICATION)}</option> : null}
                      {options.kba || r.idv === 'KBA' ? <option value="KBA">Secure link + {lowerFirst(IDV_LABEL.KBA)}</option> : null}
                    </Sel>
                  </Field>
                  <Field label="Private message (proposed)" htmlFor={`rm-${r.key}`}>
                    <Area id={`rm-${r.key}`} rows={1} disabled placeholder="Per-recipient messages are a proposed capability" />
                  </Field>
                </div>
                {options.accessCode && signsByLink(r.kind) ? <AccessCodeControl r={r} onChange={(accessCode) => upd(r.key, { accessCode })} /> : null}
                {(options.emailCode || r.emailOtp) && signsByLink(r.kind) ? (
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} title={EMAIL_CODE_OPTION.hint}>
                    <Input unstyled type="checkbox" checked={r.emailOtp} onChange={(e) => upd(r.key, { emailOtp: e.target.checked })} data-testid="email-code" />
                    {EMAIL_CODE_OPTION.label}
                  </label>
                ) : null}
                {messagingOn && r.kind === 'SIGNER' ? <TextMessageControl r={r} msg={msgFor(r)} onChange={(m) => upd(r.key, { msg: m })} /> : null}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    {r.role_key != null ? (
                      <span className="sg-tag sg-tag--grey" data-testid="template-role" title="The template role this recipient was added for">
                        {templateRoleLabel(r.role_key)}
                      </span>
                    ) : null}
                    {ordered && r.kind !== 'RECEIVES_COPY' ? (
                      <span className="sg-tag sg-tag--dark" data-testid="signing-position">
                        Signs {i + 1}
                        {i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}
                      </span>
                    ) : null}
                    {list.length > 1 ? (
                      <>
                        <LinkBtn disabled={i === 0} onClick={() => move(r.key, -1)} aria-label={`Move ${r.name || 'recipient'} up`}>
                          Move up
                        </LinkBtn>
                        <LinkBtn disabled={i === list.length - 1} onClick={() => move(r.key, 1)} aria-label={`Move ${r.name || 'recipient'} down`}>
                          Move down
                        </LinkBtn>
                      </>
                    ) : null}
                    <LinkBtn bad onClick={() => remove(r.key)}>
                      Remove
                    </LinkBtn>
                  </span>
                  <span className="sg-faint" style={{ fontSize: 12.5 }}>
                    {r.kind === 'RECEIVES_COPY' ? 'Receives a copy · no fields' : fieldCounts(r.id)}
                  </span>
                </div>
              </div>
            </section>
          ))}
          {/* UAT SND-05 — the signer limit, said out loud (the app's words): past it a new
              person receives a copy, and the Signer role is unavailable. */}
          {signerCount >= MAX_SIGNERS ? (
            <p className="sg-note" role="status" data-testid="signers-full" style={{ margin: 0 }}>
              {signersFullText(full)}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Btn onClick={() => add()} disabled={signerCount >= MAX_SIGNERS} data-testid="add-recipient">
              + Add recipient
            </Btn>
            {signerCount >= MAX_SIGNERS ? (
              <Btn onClick={() => add('', '', false, 'RECEIVES_COPY')} disabled={copyCount >= MAX_COPY_RECIPIENTS} data-testid="add-copy-recipient">
                + Add someone who receives a copy
              </Btn>
            ) : null}
            {ctx.user.email !== null && !inList(ctx.user.email) ? (
              <Btn onClick={() => add(ctx.user.display_name ?? '', ctx.user.email ?? '', true)} disabled={signerCount >= MAX_SIGNERS} data-testid="assign-to-me-add">
                + Assign to me
              </Btn>
            ) : null}
            {full ? (
              <span className="sg-tag sg-tag--grey">
                Up to {MAX_SIGNERS} signers and {MAX_COPY_RECIPIENTS} copies
              </span>
            ) : null}
          </div>
          <p className="sg-muted" style={{ fontSize: 12.5 }}>
            Add up to {MAX_SIGNERS} signers and {MAX_COPY_RECIPIENTS} people who receive a copy. Each signer gets their own secure link and signs only the
            fields assigned to them. A person who receives a copy never signs and has no fields.
          </p>
          {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        </div>
        <section className="sg-card">
          <div className="sg-card__head">From contacts</div>
          {contacts.length === 0 ? <div className="sg-empty">People you send envelopes to appear here.</div> : null}
          {contacts.length > 0 ? (
            <div style={{ padding: '8px 12px' }}>
              <TextIn
                type="search"
                value={contactQuery}
                onChange={(e) => setContactQuery(e.target.value)}
                placeholder="Search name or email"
                aria-label="Search contacts"
                data-testid="contacts-search"
              />
            </div>
          ) : null}
          {contacts.length > 0 && shownContacts.length === 0 ? <div className="sg-empty">No contacts match.</div> : null}
          <div style={{ maxHeight: 420, overflowY: 'auto' }} data-testid="contacts-list">
          {shownContacts.map((c) => (
            <div key={c.email} className="sg-row">
              <Avatar name={c.name} small />
              <div className="sg-row__main">
                <div className="sg-row__t">{c.name}</div>
                <div className="sg-row__s sg-ellipsis">{c.email}</div>
              </div>
              <LinkBtn disabled={inList(c.email) || signerCount >= MAX_SIGNERS} onClick={() => add(c.name, c.email)}>
                {inList(c.email) ? 'Added' : 'Add'}
              </LinkBtn>
            </div>
          ))}
          </div>
        </section>
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => void save(back)} disabled={saving}>
          <Icon name="back" size={14} /> Back
        </Btn>
        <Btn variant="primary" onClick={() => void save(next)} disabled={saving} data-testid="recipients-continue">
          {saving ? 'Saving…' : 'Continue'} <Icon name="next" size={14} />
        </Btn>
      </div>
    </>
  );
}

// B2 / Feature-Parity §1.9 — set, change or remove a recipient's access code. The code is
// sent once on save and never shown again (the server keeps only a salted hash).
function AccessCodeControl({ r, onChange }: { r: DraftRecipient; onChange: (code: string | null | undefined) => void }) {
  const id = `ra-${r.key}`;
  if (typeof r.accessCode === 'string') {
    return (
      <Field label="Access code" htmlFor={id} help="4 to 32 characters. Give it to the recipient yourself, not in the same email.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TextIn id={id} value={r.accessCode} maxLength={32} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} data-testid="access-code-input" />
          <LinkBtn onClick={() => onChange(undefined)}>Cancel</LinkBtn>
        </div>
      </Field>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }} data-testid="access-code">
      {r.accessCode === null ? (
        <>
          <span className="sg-muted">The access code will be removed when you continue.</span>
          <LinkBtn onClick={() => onChange(undefined)}>Undo</LinkBtn>
        </>
      ) : r.accessCodeSet ? (
        <>
          <span className="sg-tag sg-tag--ok">Access code set</span>
          <LinkBtn onClick={() => onChange('')} aria-label="Change the access code">
            Change
          </LinkBtn>
          <LinkBtn bad onClick={() => onChange(null)} aria-label="Remove the access code">
            Remove
          </LinkBtn>
        </>
      ) : (
        <LinkBtn onClick={() => onChange('')} data-testid="add-access-code">
          Add an access code
        </LinkBtn>
      )}
    </div>
  );
}

// B2 / Feature-Parity §1.7–§1.9 — the signing link also by SMS or WhatsApp, and an SMS code
// before signing. Each option shows only while available; the number is checked as E.164.
function TextMessageControl({ r, msg, onChange }: { r: DraftRecipient; msg: Msg; onChange: (m: Msg) => void }) {
  const { ctx } = useWorkspace();
  const options = sendFeaturesOf(ctx);
  const needsPhone = msg.channel !== null || msg.otp;
  const phoneBad = needsPhone && msg.phone.trim() !== '' && !E164_RE.test(msg.phone.trim());
  return (
    <div className="sg-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'start' }}>
      <div className="sg-grid" style={{ gap: 8 }}>
        {options.sms || options.whatsapp || msg.channel !== null ? (
          <Field label="Send the link by" htmlFor={`rd-${r.key}`}>
            <Sel id={`rd-${r.key}`} value={msg.channel ?? ''} onChange={(e) => onChange({ ...msg, channel: e.target.value === '' ? null : (e.target.value as DeliveryChannel) })} data-testid="delivery-channel">
              <option value="">Email</option>
              {options.sms || msg.channel === 'SMS' ? <option value="SMS">Email and text message (SMS)</option> : null}
              {options.whatsapp || msg.channel === 'WHATSAPP' ? <option value="WHATSAPP">Email and WhatsApp</option> : null}
            </Sel>
          </Field>
        ) : null}
        {options.smsCode || msg.otp ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <Input unstyled type="checkbox" checked={msg.otp} onChange={(e) => onChange({ ...msg, otp: e.target.checked })} data-testid="sms-code" />
            Ask for a code sent by SMS before signing
          </label>
        ) : null}
      </div>
      {needsPhone ? (
        <Field
          label="Mobile number"
          htmlFor={`rp-${r.key}`}
          help="International format, for example +14155550123."
          error={phoneBad ? 'Enter the number with + and the country code, no spaces.' : undefined}
        >
          <TextIn id={`rp-${r.key}`} type="tel" inputMode="tel" autoComplete="off" value={msg.phone} placeholder="+14155550123" onChange={(e) => onChange({ ...msg, phone: e.target.value })} data-testid="recipient-phone" />
        </Field>
      ) : null}
    </div>
  );
}

// ── Step 4 · Review & send ───────────────────────────────────────────────────

function ReviewStep({ env, back, onSent }: { env: EnvelopeDetail; back: string; onSent: () => void }) {
  const { base, ctx } = useWorkspace();
  const templatesManageUrl =
    templateAccess(ctx, 'use') === 'ok' && ctx.app_home_url !== null
      ? `${ctx.app_home_url.replace(/\/+$/, '')}/org/document-templates`
      : null;
  const nav = useNavigate();
  // PO 2026-11-18 — the default subject is "Please sign: {first document}" (the app's too): an
  // untouched subject (still the server's placeholder or the first document's name) takes it.
  const [subject, setSubject] = useState(() => {
    const first = env.documents[0]?.title;
    if (first === undefined) return env.subject;
    return env.subject === 'Untitled envelope' || env.subject === first ? `${SUBJECT_PREFIX}${first}`.slice(0, ENVELOPE_SUBJECT_MAX) : env.subject;
  });
  // UAT SND-20 — the sender message (M-A3 §3), at most ENVELOPE_MESSAGE_MAX characters,
  // saved on blur and again before Send if it changed.
  const [message, setMessage] = useState(env.message ?? '');
  const savedMessage = useRef(env.message ?? '');
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  // Aramo Sign Personal (Free) §4 — at a limit, offer the Business route (never a charge).
  const [upgrade, setUpgrade] = useState(false);
  // SIGN-FREE-PARITY-1 S2 — a phone_verification_required refusal with self-serve on
  // (the server's step-up status) offers the verify panel instead of the plain message.
  const [stepUp, setStepUp] = useState<PhoneStepUpStatus | null>(null);
  const ready = readinessOf(env);

  // Persist the message when it differs from what the server holds; "" clears it.
  const saveMessage = async () => {
    const next = message.trim();
    if (next === savedMessage.current.trim()) return;
    await senderApi.setMessage(env.id, next === '' ? null : next);
    savedMessage.current = next;
  };

  const send = async () => {
    setError('');
    setProblems([]);
    setUpgrade(false);
    setStepUp(null);
    setSending(true);
    try {
      await saveMessage();
      // Navigate straight to the Sent screen; updating the wizard's envelope first
      // would re-render it as SENT and redirect to the detail page instead.
      await senderApi.send(env.id, subject.trim() === '' ? undefined : subject.trim());
      onSent();
      nav(`${base}/envelopes/${env.id}/sent`);
    } catch (e) {
      const reason = refusalReason(e);
      const offer = reason === PHONE_STEP_UP_REASON ? await stepUpApi.status().catch(() => null) : null;
      if (offersPhoneStepUp(reason, offer)) {
        setStepUp(offer);
        return;
      }
      setError(errorMessage(e));
      setUpgrade(ctx.workspace === 'personal' && isAllowanceLimit(e));
      const det = (e as { details?: { problems?: unknown } }).details;
      if (Array.isArray(det?.problems)) setProblems(det.problems.filter((p): p is string => typeof p === 'string'));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="sg-grid sg-grid--main">
        <div className="sg-grid">
          <section className="sg-card">
            <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
              <Field label="Email subject" htmlFor="subject">
                <TextIn
                  id="subject"
                  value={subject}
                  maxLength={ENVELOPE_SUBJECT_MAX}
                  aria-describedby="subject-count"
                  onChange={(e) => setSubject(e.target.value.slice(0, ENVELOPE_SUBJECT_MAX))}
                />
                {/* UAT DOC-07 — a counter, and why typing stops at the limit. */}
                <div id="subject-count" className="sg-help" data-testid="envelope-subject-count" style={{ textAlign: 'right' }} aria-live="polite">
                  {subject.length >= ENVELOPE_SUBJECT_MAX ? `${SUBJECT_LIMIT_NOTE} ` : ''}
                  {subject.length} / {ENVELOPE_SUBJECT_MAX}
                </div>
              </Field>
              <Field label="Message (optional)" htmlFor="message">
                <Area
                  id="message"
                  data-testid="envelope-message"
                  rows={3}
                  maxLength={ENVELOPE_MESSAGE_MAX}
                  value={message}
                  placeholder="Add a note for the signers"
                  aria-description={`Plain text, up to ${ENVELOPE_MESSAGE_MAX} characters`}
                  onChange={(e) => setMessage(e.target.value.slice(0, ENVELOPE_MESSAGE_MAX))}
                  onBlur={() => void saveMessage().catch((e: unknown) => setError(errorMessage(e, 'Could not save the message')))}
                />
                <div className="sg-help" data-testid="envelope-message-count" style={{ textAlign: 'right' }}>
                  {message.length} / {ENVELOPE_MESSAGE_MAX}
                </div>
              </Field>
              <div className="sg-grid sg-grid--2">
                <Field label="Signing window" htmlFor="window">
                  <Sel id="window" value="7" disabled onChange={() => undefined}>
                    <option value="7">{env.signing_window_days} days (V1 baseline)</option>
                  </Sel>
                </Field>
                <Field label="Reminders" htmlFor="reminders">
                  <Sel id="reminders" value="manual" disabled onChange={() => undefined}>
                    <option value="manual">Send manually from the envelope</option>
                  </Sel>
                </Field>
              </div>
              <div className="sg-help">
                V1 baseline: a fixed {env.signing_window_days}-day signing window with reminders sent from the envelope page. Other windows and automatic
                reminder cadences are proposed product capabilities.
              </div>
            </div>
          </section>
          <section className="sg-card">
            <div className="sg-card__head">Required fields per recipient</div>
            {env.recipients.length === 0 ? <div className="sg-empty">No recipients yet.</div> : null}
            {env.recipients.map((r, i) => {
              const f = env.fields.filter((x) => x.signer_id === r.id);
              return (
                <div key={r.id} className="sg-row">
                  <span className="sg-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                  <div className="sg-row__main">
                    <strong>{r.name}</strong>{' '}
                    <span className="sg-muted">
                      · {roleLabel(r.recipient_kind)}
                      {isCopyRecipient(r) ? ` · ${COPY_TIMING_LABEL[r.copy_delivery ?? 'ON_COMPLETION']}` : r.recipient_kind === 'IN_PERSON_SIGNER' ? '' : ' · Secure link'}
                      {r.recipient_kind === 'WITNESS' ? ` · witnesses ${env.recipients.find((x) => x.id === r.witness_for_signer_id)?.name ?? 'a signer'}` : ''}
                      {r.identity_verification_method != null ? ` · ${lowerFirst(IDV_LABEL[r.identity_verification_method])}` : ''}
                      {r.access_code_set === true ? ' · access code' : ''}
                      {r.email_otp_required === true ? ' · email code' : ''}
                    </span>
                  </div>
                  <span className="sg-muted" style={{ fontSize: 12.5 }}>
                    {isCopyRecipient(r) ? 'No fields' : `${f.filter((x) => x.required).length} required · ${f.filter((x) => !x.required).length} optional`}
                  </span>
                </div>
              );
            })}
          </section>
        </div>
        <section className="sg-card">
          <div className="sg-card__body">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Before sending</div>
            {ready.items.map((it) => (
              <div key={it.t} className="sg-check">
                <span className={it.ok ? 'sg-check__ok' : 'sg-check__no'} aria-hidden="true">
                  {it.ok ? '✓' : '!'}
                </span>
                {it.t}
              </div>
            ))}
            <div className="sg-grid" style={{ marginTop: 14, gap: 8 }}>
              <Btn variant="primary" block disabled={!ready.ok || sending} onClick={() => void send()} data-testid="send-envelope">
                {sending ? 'Sending…' : ready.ok ? 'Send for signature' : 'Resolve the items above to send'}
              </Btn>
              {/* DOC-TEMPLATE-LIB-1 T-5 (ADR-0034 D5/D11) — templates are created and approved in
                  Org Home (Documents-owned), never saved from a Sign envelope. */}
              {templatesManageUrl !== null ? (
                <a className="sg-btn sg-btn--block" href={templatesManageUrl} data-testid="manage-templates">
                  Manage templates in Org Home
                </a>
              ) : null}
            </div>
            <p className="sg-help" style={{ marginTop: 10 }}>
              Each signer gets an email with a secure link to sign at sign.aramo.ai. They don’t need an Aramo account.
            </p>
            {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
            {stepUp !== null ? (
              <PhoneStepUpPanel
                status={stepUp}
                onVerified={() => void send()}
                onClose={() => {
                  setStepUp(null);
                  setError(REFUSAL_COPY[PHONE_STEP_UP_REASON] ?? '');
                }}
              />
            ) : null}
            {upgrade ? <PersonalUpgradeLink /> : null}
            {problems.length > 0 ? (
              <ul className="sg-muted" style={{ fontSize: 12.5 }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(back)}>
          <Icon name="back" size={14} /> Back
        </Btn>
      </div>
    </>
  );
}

// ── Sent ─────────────────────────────────────────────────────────────────────

// Web Self-Signing A2 §3.3 — the Sign step of "Sign a document": the subject (empty takes the
// document name), the readiness checks, and Sign now: send (a SELF send emails nobody and uses
// no envelope), then the SELF session (W1), then the signing page with the return hint (§3.4).
export const SELF_SIGN_NOTE = 'Nobody is emailed and this doesn’t count toward your envelopes.';

export function selfSignReturnPath(base: string, envelopeId: string): string {
  return `${base}/envelopes/${envelopeId}`;
}

function SelfSignStep({ env, back, onSent }: { env: EnvelopeDetail; back: string; onSent: () => void }) {
  const { base } = useWorkspace();
  const nav = useNavigate();
  const [subject, setSubject] = useState(env.subject === 'Untitled envelope' && env.documents[0] !== undefined ? env.documents[0].title : env.subject);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = readinessOf(env);

  const signNow = async () => {
    setError('');
    setBusy(true);
    try {
      await senderApi.send(env.id, subject.trim() === '' ? undefined : subject.trim());
      onSent();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    try {
      const s = await senderApi.selfSignSession(env.id);
      const ret = encodeURIComponent(selfSignReturnPath(base, env.id));
      window.location.assign(`/s/${encodeURIComponent(s.token)}?ret=${ret}`);
    } catch (e) {
      // Signed nothing yet: the envelope page offers Sign now (W1) for it.
      setError(selfSignRefusal(e));
      setBusy(false);
      nav(selfSignReturnPath(base, env.id));
    }
  };

  return (
    <>
      <div className="sg-grid sg-grid--main">
        <section className="sg-card">
          <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
            <Field label="Document name" htmlFor="self-subject">
              <TextIn
                id="self-subject"
                value={subject}
                maxLength={ENVELOPE_SUBJECT_MAX}
                onChange={(e) => setSubject(e.target.value.slice(0, ENVELOPE_SUBJECT_MAX))}
              />
            </Field>
            <p className="sg-help" data-testid="self-sign-note" style={{ margin: 0 }}>
              You’re the only signer. {SELF_SIGN_NOTE}
            </p>
          </div>
        </section>
        <section className="sg-card">
          <div className="sg-card__body">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Before signing</div>
            {ready.items.map((it) => (
              <div key={it.t} className="sg-check">
                <span className={it.ok ? 'sg-check__ok' : 'sg-check__no'} aria-hidden="true">
                  {it.ok ? '✓' : '!'}
                </span>
                {it.t}
              </div>
            ))}
            <div style={{ marginTop: 14 }}>
              <Btn variant="primary" block disabled={!ready.ok || busy} onClick={() => void signNow()} data-testid="self-sign-now">
                {busy ? 'Opening…' : ready.ok ? 'Sign now' : 'Resolve the items above to sign'}
              </Btn>
            </div>
            {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
          </div>
        </section>
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(back)}>
          <Icon name="back" size={14} /> Back
        </Btn>
      </div>
    </>
  );
}

export function EnvelopeSent() {
  const { id = '' } = useParams();
  const { base } = useWorkspace();
  const [env, setEnv] = useState<EnvelopeDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .detail(id)
      .then(setEnv)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);
  if (error !== '')
    return (
      <div className="sg-page">
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  if (env === null) return <Loading />;
  return (
    <div className="sg-page" style={{ maxWidth: 760 }}>
      <section className="sg-card" data-testid="sent-screen">
        <div className="sg-card__body" style={{ textAlign: 'center', padding: '28px 20px' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--okbg)', color: 'var(--ok)', display: 'grid', placeItems: 'center', margin: '0 auto 10px', fontWeight: 700 }}>
            ✓
          </div>
          <h1 className="sg-h1">Envelope sent</h1>
          <p className="sg-lede">“{env.subject}” is on its way. Each signer gets an email with a secure link.</p>
        </div>
        {env.recipients.map((r) => (
          <div key={r.id} className="sg-row">
            <Avatar name={r.name} small />
            <div className="sg-row__main">
              <div className="sg-row__t">{r.name}</div>
              <div className="sg-row__s">
                {r.email ?? 'No email'} ·{' '}
                {isCopyRecipient(r)
                  ? r.copy_delivery === 'ON_COMPLETION'
                    ? 'Gets a copy when everyone has signed'
                    : 'Copy sent by email'
                  : r.recipient_kind === 'IN_PERSON_SIGNER'
                    ? 'Signs in person in the Aramo Sign app'
                    : 'Secure link sent by email'}
              </div>
            </div>
            <RecipientPill status={r.status} />
          </div>
        ))}
        <div className="sg-card__body sg-muted" style={{ fontSize: 12.5 }}>
          Signing links go only to each signer’s inbox and are never shown here. They stay valid for {env.signing_window_days} days.
        </div>
      </section>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Link className="sg-btn sg-btn--primary" to={`${base}/envelopes/${env.id}`}>
          View envelope
        </Link>
        <Link className="sg-btn" to={`${base}/envelopes`}>
          Back to envelopes
        </Link>
      </div>
    </div>
  );
}

/** UAT (contacts) — the From contacts search: name or email, case-insensitive (the app's rule). */
export function filterContactRows(rows: readonly ContactRow[], query: string): ContactRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
}

/** UAT SND-05 / C3 row 20 — the signer-limit note (the app's words: @aramo/sign-client). */
export function signersFullText(everyoneFull: boolean): string {
  return everyoneFull
    ? `${SIGNERS_FULL_MESSAGE} It can also have at most ${MAX_COPY_RECIPIENTS} people who receive a copy.`
    : `${SIGNERS_FULL_MESSAGE} Add anyone else as someone who receives a copy.`;
}

/** PO 2026-11-18 — the default subject's prefix: the one rule's (@aramo/sign-client), also the app's and the emails'. */
export const SUBJECT_PREFIX = SIGN_SUBJECT_PREFIX;

/** PO 2026-11-18 — open a draft document's PDF in a new tab (the envelope page's Preview). */
export async function previewDocument(envelopeId: string, documentId: string, onError: (m: string) => void): Promise<void> {
  // Opened first (inside the click), so a pop-up blocker allows it; filled once the bytes arrive.
  const tab = window.open('', '_blank');
  try {
    const bytes = await fetchSourcePdf(envelopeId, documentId);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (tab !== null) tab.location.href = url;
    else window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    tab?.close();
    onError(errorMessage(e, 'The document couldn’t be opened. Try again.'));
  }
}
