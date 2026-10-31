import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Button, Checkbox, Input, Select, TextArea } from '@aramo/fe-foundation';

import type { EnvelopeStatus, RecipientStatus } from './api';

// Thin presentation wrappers over the fe-foundation primitives (G1/R2: raw
// interactive elements are banned in app code — `unstyled` keeps Sign's own
// classes). Status vocabulary mirrors the prototype's STATUS / RSTATUS maps.

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'sm';
  block?: boolean;
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn({ variant = 'default', size = 'md', block = false, className, ...rest }, ref) {
  const cls = [
    'sg-btn',
    variant !== 'default' ? `sg-btn--${variant}` : '',
    size === 'sm' ? 'sg-btn--sm' : '',
    block ? 'sg-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <Button ref={ref} unstyled className={cls} {...rest} />;
});

export function LinkBtn({ className, bad, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { bad?: boolean }) {
  return <Button unstyled className={['sg-link', bad === true ? 'sg-link--bad' : '', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export const TextIn = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextIn({ className, ...rest }, ref) {
  return <Input ref={ref} unstyled className={['sg-input', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
});

export function Sel({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <Select unstyled className={['sg-select', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export function Area({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <TextArea unstyled className={['sg-textarea', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

export function Check(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <Checkbox unstyled {...props} />;
}

/** Id of a Field's inline error message, for the control's aria-describedby. */
export const fieldErrorId = (htmlFor: string) => `${htmlFor}-error`;

export function Field({ label, help, children, htmlFor, error }: { label: string; help?: ReactNode; children: ReactNode; htmlFor?: string; error?: string | undefined }) {
  return (
    <div className="sg-field">
      <label className="sg-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help !== undefined ? <div className="sg-help">{help}</div> : null}
      {error !== undefined ? (
        <div className="sg-field-error" id={htmlFor !== undefined ? fieldErrorId(htmlFor) : undefined}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export const STATUS: Record<EnvelopeStatus, [string, string, string]> = {
  DRAFT: ['Draft', 'var(--bg)', 'var(--muted)'],
  SENT: ['Sent', 'var(--accent-soft)', 'var(--accent)'],
  IN_PROGRESS: ['In progress', 'var(--accent-soft)', 'var(--accent)'],
  COMPLETED: ['Completed', 'var(--okbg)', 'var(--ok)'],
  DECLINED: ['Declined', 'var(--badbg)', 'var(--bad)'],
  VOIDED: ['Voided', 'var(--bg)', 'var(--muted)'],
  EXPIRED: ['Expired', 'var(--warnbg)', 'var(--warn)'],
};

export const RSTATUS: Record<RecipientStatus, [string, string, string]> = {
  PENDING: ['Pending', 'var(--bg)', 'var(--muted)'],
  VIEWED: ['Viewed', 'var(--accent-soft)', 'var(--accent)'],
  SIGNED: ['Signed', 'var(--okbg)', 'var(--ok)'],
  DECLINED: ['Declined', 'var(--badbg)', 'var(--bad)'],
};

export function StatusPill({ status }: { status: EnvelopeStatus }) {
  const [label, bg, col] = STATUS[status] ?? [status, 'var(--bg)', 'var(--muted)'];
  return (
    <span className="sg-pill" style={{ background: bg, color: col }} data-testid="status-pill">
      {label}
    </span>
  );
}

export function RecipientPill({ status }: { status: RecipientStatus }) {
  const [label, bg, col] = RSTATUS[status] ?? [status, 'var(--bg)', 'var(--muted)'];
  return (
    <span className="sg-pill" style={{ background: bg, color: col }}>
      {label}
    </span>
  );
}

export const COLORS = ['#2447D8', '#7A3B52', '#0E7C66', '#C2410C', '#6B4FBB'];

export function initials(name: string | null | undefined): string {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function Avatar({ name, color, small }: { name: string | null | undefined; color?: string; small?: boolean }) {
  return (
    <span className={small === true ? 'sg-avatar sg-avatar--sm' : 'sg-avatar'} style={color !== undefined ? { background: color, color: '#fff', border: 0 } : undefined} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return withTime ? `${date} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : date;
}

export function rel(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return '';
  const m = (now - new Date(iso).getTime()) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Masks an email for the certificate view: a•••@b•••.com
export function maskEmail(email: string): string {
  return email.replace(/^(.)[^@]*@(.)[^.]*/, '$1•••@$2•••');
}

const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V21H3z',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  tpl: 'M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z',
  doc: 'M6 3h9l4 4v14H6zM15 3v4h4',
  contacts: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  activity: 'M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.6 1.6 0 0 0-2.6.6V21h-4v-.8a1.6 1.6 0 0 0-2.6-.6l-.1.1-2.8-2.8.1-.1a1.6 1.6 0 0 0-.6-2.6H3v-4h.8a1.6 1.6 0 0 0 .6-2.6l-.1-.1 2.8-2.8.1.1a1.6 1.6 0 0 0 2.6-.6V3h4v.8a1.6 1.6 0 0 0 2.6.6l.1-.1 2.8 2.8-.1.1a1.6 1.6 0 0 0 .6 2.6h.8v4z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  back: 'M19 12H5M11 6l-6 6 6 6',
  next: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  x: 'M6 6l12 12M18 6 6 18',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  swap: 'M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4',
  ext: 'M7 17 17 7M9 7h8v8',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
    </svg>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sg-empty">
      <div className="sg-empty__t">{title}</div>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="sg-empty" role="status">
      {label}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="sg-error" role="alert">
      {children}
    </div>
  );
}

// Event label for the ledger (prototype vocabulary).
export function eventLabel(type: string, detail: Record<string, string> | null): string {
  const map: Record<string, string> = {
    ENVELOPE_CREATED: 'Envelope created',
    DOCUMENT_ATTACHED: 'Document attached',
    DOCUMENT_REMOVED: 'Document removed',
    ENVELOPE_SENT: 'Envelope sent',
    ENVELOPE_IN_PROGRESS: 'Signing started',
    SESSION_EXCHANGED: 'Invitation opened',
    DISCLOSURE_ACCEPTED: 'E-record consent accepted',
    SIGNER_SIGNED: 'Signed',
    ENVELOPE_COMPLETED: 'Envelope completed · certificate issued',
    ENVELOPE_DECLINED: 'Declined',
    ENVELOPE_VOIDED: 'Envelope voided',
    ENVELOPE_EXPIRED: 'Link expired',
    SIGNATURE_REMINDER_SENT: 'Reminder sent',
    // Retention and Purge (DocuSign parity).
    ENVELOPE_PURGE_QUEUED: 'Purge scheduled',
    ENVELOPE_PURGE_DEQUEUED: 'Purge cancelled',
    ENVELOPE_PURGED: 'Documents purged',
    ENVELOPE_DELETED_BY_PARTY: 'Moved to Deleted',
    ENVELOPE_RESTORED_BY_PARTY: 'Restored from Deleted',
  };
  const base = map[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  if (/^ENVELOPE_PURGE/.test(type)) return base;
  if (detail?.['reason'] !== undefined) return `${base} · “${detail['reason']}”`;
  if (detail?.['title'] !== undefined) return `${base} · ${detail['title']}`;
  return base;
}

export function eventDot(type: string): string {
  if (/SIGNED|COMPLETED/.test(type)) return 'var(--ok)';
  if (/DECLINED|EXPIRED|VOIDED/.test(type)) return 'var(--bad)';
  return 'var(--accent)';
}

export function downloadBase64(base64: string, filename: string, type = 'application/pdf'): void {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// A fe-foundation Button with ONLY the caller's class (icon buttons, menu rows).
export function Bare({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button unstyled className={className} {...rest} />;
}

// Retention and Purge — a compact tag for an envelope with a scheduled or completed purge.
export function PurgeTag({ purge }: { purge: { state: string; due_at: string | null; executed_at: string | null } | null | undefined }) {
  if (purge === null || purge === undefined || purge.state === 'DEQUEUED') return null;
  if (purge.state === 'EXECUTED')
    return (
      <span className="sg-tag sg-tag--grey" data-testid="purge-tag">
        Purged
      </span>
    );
  return (
    <span className="sg-tag sg-tag--warn" data-testid="purge-tag" title={purge.due_at === null ? undefined : `Documents are deleted on ${fmtDate(purge.due_at)}`}>
      Purge scheduled
    </span>
  );
}
