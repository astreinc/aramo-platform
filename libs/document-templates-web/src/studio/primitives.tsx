import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Dialog, DialogClose, Input, StatusPill, TextArea, type PillTone } from '@aramo/fe-foundation';

import './studio-primitives.css';

// TEMPLATE-STUDIO-1 S-0 (directive §2) — the Studio's lib-local primitives. They were the
// platform console's components (PLATFORM-UX-1 F-1: Pill, EmptyState, Skeleton,
// ConfirmDialog + fields, TagInput, return-focus); the Studio now carries its own copies
// so it renders in any host. Same markup and the same design values, expressed as `ts-*`
// classes over the Studio's `--ts-*` tokens (studio-primitives.css).

// ─── focus return ───────────────────────────────────────────────────────────

/**
 * Focus returns to the opener when a dialog closes (handoff §3.8, §15): captured in a
 * layout effect when `open` turns true (before Radix moves focus into the content) and
 * focused again after the content has unmounted — also when the dialog unmounts open.
 */
export function useReturnFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      container.current = opener.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return undefined;
    }
    if (!wasOpen.current) return undefined;
    wasOpen.current = false;
    const target = opener.current;
    const fallback = container.current;
    opener.current = null;
    if (target === null) return undefined;
    const timer = window.setTimeout(() => {
      if (target.isConnected) target.focus();
      else if (fallback?.isConnected) fallback.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(
    () => () => {
      const target = wasOpen.current ? opener.current : null;
      const fallback = container.current;
      if (target === null) return;
      window.setTimeout(() => {
        if (document.activeElement !== null && document.activeElement !== document.body) return;
        if (target.isConnected) target.focus();
        else if (fallback?.isConnected) fallback.focus();
      }, 0);
    },
    [],
  );
}

// ─── status pill ────────────────────────────────────────────────────────────

export type StudioTone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'muted';

export interface PillSpec {
  readonly label: string;
  readonly tone: StudioTone;
}

export interface PillProps {
  readonly tone: StudioTone;
  readonly children: ReactNode;
  /** sm = inline, md = status pill (default), lg = dialog Change box. */
  readonly size?: 'sm' | 'md' | 'lg';
  /** The leading 6px dot. Default: true for md, false otherwise. */
  readonly dot?: boolean;
  /** 700 weight (the "to" pill in a Change box). */
  readonly strong?: boolean;
}

const FOUNDATION_TONE: Readonly<Record<StudioTone, PillTone>> = {
  ok: 'ok',
  info: 'info',
  warn: 'warn',
  danger: 'danger',
  neutral: 'neutral',
  muted: 'muted',
};

export function Pill({ tone, children, size = 'md', dot, strong = false }: PillProps) {
  const showDot = dot ?? size === 'md';
  const cls = ['ts-pill', `ts-pill--${tone}`, `ts-pill--${size}`, strong ? 'ts-pill--strong' : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} data-tone={tone}>
      <StatusPill tone={FOUNDATION_TONE[tone]} dot={showDot}>
        {children}
      </StatusPill>
    </span>
  );
}

// ─── empty state · skeleton ─────────────────────────────────────────────────

export function EmptyState({ title, body }: { readonly title?: ReactNode; readonly body?: ReactNode }) {
  return (
    <div className="ts-empty ts-empty--md">
      {title !== undefined ? <div className="ts-empty__title">{title}</div> : null}
      {body !== undefined ? <div className={title !== undefined ? 'ts-empty__body' : 'ts-empty__body ts-empty__body--solo'}>{body}</div> : null}
    </div>
  );
}

function Skeleton({ width = '100%', height = 14, radius = 4 }: { readonly width?: number | string; readonly height?: number; readonly radius?: number }) {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className="ts-skeleton" style={style} aria-hidden="true" />;
}

/** A panel's loading block: 16px 20px padding, 12px gap, 14px lines. */
export function SkeletonPanel({ lines = ['100%', '80%', '90%'], label = 'Loading…' }: { readonly lines?: readonly (number | string)[]; readonly label?: string }) {
  return (
    <div className="ts-skeleton-panel" aria-busy="true">
      <span className="ts-sr-only" role="status">
        {label}
      </span>
      {lines.map((w, i) => (
        <Skeleton key={i} width={w} />
      ))}
    </div>
  );
}

// ─── confirm dialog ─────────────────────────────────────────────────────────

/** normal = midnight · privileged = terracotta with midnight text · danger = terminal. */
export type ConfirmTone = 'normal' | 'privileged' | 'danger';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  /** The Change box: shown when both are given. */
  readonly from?: PillSpec | null;
  readonly to?: PillSpec | null;
  readonly consequence?: ReactNode;
  readonly children?: ReactNode;
  readonly error?: ReactNode | null;
  readonly commitLabel: string;
  readonly tone?: ConfirmTone;
  /** False keeps commit disabled at 45% opacity. Default: true. */
  readonly canCommit?: boolean;
  readonly busy?: boolean;
  readonly onCommit: () => void;
}

/**
 * The confirm dialog pattern (handoff §3.8) on the fe-foundation Dialog (Radix: focus
 * trap, Esc closes): the Change box (from → to), the consequence line, the caller's
 * fields, the error (role="alert"). Styled through `.tc-dialog__content:has(.ts-cd)`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  from,
  to,
  consequence,
  children,
  error,
  commitLabel,
  tone = 'normal',
  canCommit = true,
  busy = false,
  onCommit,
}: ConfirmDialogProps) {
  useReturnFocus(open);
  const disabled = !canCommit || busy;
  const footer = (
    <>
      <Button unstyled className="ts-btn ts-btn--secondary" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      <Button
        unstyled
        className={`ts-btn ts-btn--${tone}${canCommit ? '' : ' ts-btn--dim'}`}
        disabled={disabled}
        aria-busy={busy || undefined}
        onClick={() => {
          if (!disabled) onCommit();
        }}
      >
        {commitLabel}
      </Button>
    </>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} footer={footer}>
      <div className="ts-cd">
        {from && to ? (
          <div className="ts-cd__change">
            <span className="ts-cd__change-label">Change</span>
            <Pill tone={from.tone} size="lg">
              {from.label}
            </Pill>
            <span className="ts-cd__arrow" aria-hidden="true">
              →
            </span>
            <span className="ts-sr-only"> to </span>
            <Pill tone={to.tone} size="lg" strong>
              {to.label}
            </Pill>
          </div>
        ) : null}
        {consequence ? <p className="ts-cd__consequence">{consequence}</p> : null}
        {children ? <div className="ts-cd__fields">{children}</div> : null}
        {error ? (
          <div role="alert" className="ts-alert ts-alert--error ts-cd__error">
            {error}
          </div>
        ) : null}
        {/* After the content, so focus lands on the first field when the dialog opens. */}
        <DialogClose className="ts-cd__close" aria-label="Close">
          ×
        </DialogClose>
      </div>
    </Dialog>
  );
}

// ─── dialog fields ──────────────────────────────────────────────────────────

interface FieldBase {
  readonly label: ReactNode;
  readonly helper?: ReactNode;
  readonly required?: boolean;
}

export interface FieldTextProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'number';
}

export function FieldText({ label, helper, required, value, onChange, type = 'text' }: FieldTextProps) {
  const id = useId();
  return (
    <div className="ts-field">
      <label className="ts-field__labelwrap" htmlFor={id}>
        <span className="ts-field__label">{label}</span>
      </label>
      <Input
        id={id}
        unstyled
        type={type}
        className="ts-input"
        value={value}
        required={required}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {helper ? (
        <span id={`${id}-help`} className="ts-field__helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}

export interface FieldTextAreaProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Hard cap; shows the "n / max" counter. */
  readonly max?: number;
  readonly rows?: number;
}

export function FieldTextArea({ label, helper, required, value, onChange, max, rows = 3 }: FieldTextAreaProps) {
  const id = useId();
  return (
    <div className="ts-field">
      <label className="ts-field__labelwrap" htmlFor={id}>
        <span className="ts-field__label">{label}</span>
      </label>
      <TextArea
        id={id}
        unstyled
        className="ts-textarea"
        rows={rows}
        value={value}
        required={required}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(max ? e.target.value.slice(0, max) : e.target.value)}
      />
      {max ? (
        <span className="ts-field__count" aria-live="polite">
          {value.length} / {max}
        </span>
      ) : null}
      {helper ? (
        <span id={`${id}-help`} className="ts-field__helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}

// ─── tag input ──────────────────────────────────────────────────────────────

export interface TagInputProps {
  readonly label: string;
  readonly tags: readonly string[];
  readonly onChange: (tags: string[]) => void;
  readonly placeholder?: string;
  readonly max?: number;
}

const normalizeTag = (draft: string): string => draft.toUpperCase().replace(/[^A-Z0-9_]/g, '');

/** Mono chips with a remove ×, and a borderless input that adds a tag on Enter. */
export function TagInput({ label, tags, onChange, placeholder = 'TAG ↵', max = 16 }: TagInputProps) {
  const id = useId();
  const [draft, setDraft] = useState('');

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && draft) {
      e.preventDefault();
      if (!tags.includes(draft) && tags.length < max) onChange([...tags, draft]);
      setDraft('');
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="ts-field">
      <label className="ts-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ts-taginput">
        {tags.map((t) => (
          <span key={t} className="ts-taginput__tag">
            {t}
            <Button unstyled className="ts-taginput__rm" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              ×
            </Button>
          </span>
        ))}
        <Input
          id={id}
          unstyled
          className="ts-taginput__input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(normalizeTag(e.target.value))}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
