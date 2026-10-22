import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { AUTH_PRODUCTS, AuthShell, Button, Checkbox, Input, Select } from '@aramo/fe-foundation';

import './signup.css';

// Aramo Sign signup & activation — the shared visual parts (handoff "Aramo Sign:
// signup and activation", design `platform/sign/Aramo Sign Signup v2.dc.html`).
// Presentation only: every decision (eligibility, next step, refusal) stays with
// the backend endpoints the pages already call.

export const SUPPORT_URL = 'https://aramo.ai/company/contact.html?route=Aramo%20Sign';
export const CONTACT_SALES_URL = SUPPORT_URL;
export const RESEND_SECONDS = 60;

// ── Icons ──────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  clock: 'M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  building: 'M4 21V5l8-2v18M12 21V9l8 2v10M2 21h20M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2',
  check: 'M20 6 9 17l-5-5',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  shield: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function SuIcon({
  name,
  size = 21,
  stroke = 'currentColor',
}: {
  name: IconName;
  size?: number;
  stroke?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** The aramo mark in brand blue (activation header, §4.1). */
export function BlueMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g stroke="#022AC0" strokeWidth="5" strokeLinecap="round">
        <line x1="43" y1="32" x2="56" y2="32" />
        <line x1="32" y1="43" x2="32" y2="56" />
        <line x1="24.2" y1="39.8" x2="15" y2="49" />
        <line x1="21" y1="32" x2="8" y2="32" />
        <line x1="24.2" y1="24.2" x2="15" y2="15" />
        <line x1="32" y1="21" x2="32" y2="8" />
        <line x1="39.8" y1="39.8" x2="49" y2="49" />
      </g>
      <line
        x1="39.8"
        y1="24.2"
        x2="54.5"
        y2="9.5"
        stroke="#d97757"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="6" fill="#022AC0" />
    </svg>
  );
}

// ── Headings that take focus when a new screen appears ─────────────────────

function useFocusOnChange<T extends HTMLElement>(key: string) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [key]);
  return ref;
}

export function CardTitle({ title, sub }: { title: string; sub?: ReactNode }) {
  const ref = useFocusOnChange<HTMLHeadingElement>(title);
  return (
    <div>
      <h1 className="su-card-title" ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {sub !== undefined ? <p className="su-card-sub">{sub}</p> : null}
    </div>
  );
}

export function StepHead({ title, sub }: { title: string; sub?: ReactNode }) {
  const ref = useFocusOnChange<HTMLHeadingElement>(title);
  return (
    <div>
      <h1 className="su-step-title" ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {sub !== undefined ? <p className="su-step-sub">{sub}</p> : null}
    </div>
  );
}

// ── /signup frame: the shared Aramo sign-in frame (§3.1) ───────────────────

export function SignupFrame({
  children,
  label = 'Create your Aramo Sign account',
  testId,
}: {
  children: ReactNode;
  label?: string;
  testId?: string;
}) {
  return (
    <AuthShell
      product={AUTH_PRODUCTS.sign}
      className="su-auth"
      cardClassName="su-card"
      cardLabel={label}
      idpNote="No passwords. You sign in with your Google or Microsoft account."
    >
      <div className="su-stack" data-testid={testId}>
        {children}
      </div>
    </AuthShell>
  );
}

export type Tone = 'blue' | 'amber' | 'grey' | 'green' | 'red';

/** A card state (§3.5, §3.6): icon tile, title, body, actions. */
export function StateBlock({
  tone,
  icon,
  title,
  sub,
  children,
  heading = 'card',
}: {
  tone: Tone;
  icon: IconName;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
  heading?: 'card' | 'step';
}) {
  const subProp = sub !== undefined ? { sub } : {};
  return (
    <>
      <span className={`su-tile su-tile--${tone}`} aria-hidden="true">
        <SuIcon name={icon} />
      </span>
      {heading === 'card' ? (
        <CardTitle title={title} {...subProp} />
      ) : (
        <StepHead title={title} {...subProp} />
      )}
      {children}
    </>
  );
}

// ── Activation shell (§4.1, §4.2) ──────────────────────────────────────────

export interface StepDef {
  key: string;
  label: string;
}
export interface StepGroupDef {
  label: string;
  items: readonly StepDef[];
}

type Status = 'done' | 'current' | 'future';

export function ActivationShell({
  groups,
  current,
  allDone = false,
  onGo,
  who,
  testId,
  children,
}: {
  /** Omit for a screen outside the steps (no step list, no progress bar). */
  groups?: readonly StepGroupDef[];
  current?: string;
  allDone?: boolean;
  /** Returns to a done step; omitted, done steps are not clickable. */
  onGo?: (key: string) => void;
  /** Right side of the header. */
  who?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const flat = groups?.flatMap((g) => g.items) ?? [];
  const idx = current === undefined ? -1 : flat.findIndex((s) => s.key === current);
  const status = (i: number): Status =>
    allDone || i < idx ? 'done' : i === idx ? 'current' : 'future';
  const withSteps = groups !== undefined && (idx >= 0 || allDone);
  let n = 0;
  return (
    <div className="su" data-testid={testId}>
      <header className="su-head">
        <BlueMark />
        <span className="su-head__name">Aramo Sign</span>
        <span className="su-head__end">
          {who !== undefined ? <span className="su-head__who">{who}</span> : null}
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
            Help
          </a>
        </span>
      </header>
      {withSteps && !allDone && idx >= 0 ? (
        <div className="su-progress" data-testid="setup-progress">
          <div>
            <b>
              Step {idx + 1} of {flat.length}
            </b>{' '}
            · {flat[idx]?.label}
          </div>
          <div className="su-progress__track" aria-hidden="true">
            <div
              className="su-progress__fill"
              style={{ width: `${Math.round(((idx + 1) / flat.length) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className={withSteps ? 'su-body' : 'su-body su-body--plain'}>
        {withSteps && groups !== undefined ? (
          <nav className="su-steps" aria-label="Setup steps">
            {groups.map((g) => {
              const first = n;
              n += g.items.length;
              const states = g.items.map((_, j) => status(first + j));
              const gs: Status = states.every((s) => s === 'done')
                ? 'done'
                : states.includes('current')
                  ? 'current'
                  : 'future';
              return (
                <div key={g.label} className={`su-group su-group--${gs}`}>
                  <div className="su-group__head">
                    <span className="su-group__ring" aria-hidden="true">
                      {gs === 'done' ? '✓' : ''}
                    </span>
                    <span>{g.label}</span>
                  </div>
                  <div className="su-group__items">
                    {g.items.map((it, j) => {
                      const s = states[j] ?? 'future';
                      const clickable = s === 'done' && !allDone && onGo !== undefined;
                      return (
                        <Button
                          key={it.key}
                          unstyled
                          className={`su-substep su-substep--${s}`}
                          disabled={!clickable}
                          aria-current={s === 'current' ? 'step' : undefined}
                          onClick={clickable ? () => onGo(it.key) : undefined}
                          data-testid={`step-${it.key}`}
                        >
                          <span className="su-substep__dot" aria-hidden="true">
                            {s === 'done' ? '✓' : ''}
                          </span>
                          {it.label}
                          {s === 'done' ? (
                            <span className="su-visually-hidden"> (done)</span>
                          ) : null}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
        ) : null}
        <main className="su-main">
          <div className="su-form">{children}</div>
        </main>
      </div>
    </div>
  );
}

// ── Form parts (§4.3) ──────────────────────────────────────────────────────

export const errorId = (id: string) => `${id}-error`;
export const helpId = (id: string) => `${id}-help`;

/** aria for a control with an optional help line and an optional error. */
export function ariaFor(
  id: string,
  error: string | undefined,
  help: boolean,
): Record<string, string | boolean | undefined> {
  const ids = [error !== undefined ? errorId(id) : null, help ? helpId(id) : null]
    .filter(Boolean)
    .join(' ');
  return {
    'aria-invalid': error !== undefined ? true : undefined,
    'aria-describedby': ids !== '' ? ids : undefined,
  };
}

export function SuField({
  id,
  label,
  optional,
  help,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  help?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="su-field">
      <label className="su-label" htmlFor={id}>
        {label}
        {optional === true ? <span className="su-label__opt"> (optional)</span> : null}
      </label>
      {children}
      {help !== undefined ? (
        <div className="su-help" id={helpId(id)}>
          {help}
        </div>
      ) : null}
      {error !== undefined ? (
        <div className="su-error" id={errorId(id)} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export const SuInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
>(function SuInput({ className, mono, ...rest }, ref) {
  return (
    <Input
      ref={ref}
      unstyled
      className={['su-input', mono === true ? 'su-input--mono' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
});

export function SuSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Select
      unstyled
      className={['su-select', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}

export function LockedField({
  id,
  label,
  value,
  help,
}: {
  id: string;
  label: string;
  value: ReactNode;
  help?: ReactNode;
}) {
  return (
    <div className="su-field">
      <span className="su-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className="su-locked"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={help !== undefined ? helpId(id) : undefined}
        data-testid={id}
      >
        <SuIcon name="lock" size={14} stroke="#93A0A8" />
        <span>{value}</span>
      </div>
      {help !== undefined ? (
        <div className="su-help" id={helpId(id)}>
          {help}
        </div>
      ) : null}
    </div>
  );
}

export function SuCheck({
  id,
  checked,
  onChange,
  error,
  testId,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | undefined;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="su-field">
      <label className="su-check" htmlFor={id}>
        <Checkbox
          unstyled
          id={id}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid={testId}
          {...ariaFor(id, error, false)}
        />
        <span>{children}</span>
      </label>
      {error !== undefined ? (
        <div className="su-error" id={errorId(id)} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function Alert({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="su-alert" role="alert" data-testid={testId}>
      <div>{children}</div>
    </div>
  );
}

export function PrimaryBtn({
  children,
  type = 'button',
  block,
  ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  type?: 'button' | 'submit';
  block?: boolean;
}) {
  return (
    <Button
      unstyled
      type={type}
      className={block === true ? 'su-btn su-btn--primary su-btn--block' : 'su-btn su-btn--primary'}
      {...rest}
    >
      {children}
    </Button>
  );
}

export function SecondaryBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button unstyled className="su-btn" {...rest}>
      {children}
    </Button>
  );
}

export function LinkBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button unstyled className="su-linkbtn" {...rest}>
      {children}
    </Button>
  );
}

/** Step footer (§4.3): Back on the left when there is a previous step, the primary on the right. */
export function StepFooter({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="su-footer">
      {onBack !== undefined ? (
        <SecondaryBtn onClick={onBack} data-testid="step-back">
          Back
        </SecondaryBtn>
      ) : null}
      <span className="su-footer__space" />
      {children}
    </div>
  );
}

export function ProviderLink({
  provider,
  href,
  testId,
}: {
  provider: 'microsoft' | 'google';
  href: string;
  testId: string;
}) {
  return (
    <a className="su-provider" href={href} data-testid={testId}>
      {provider === 'microsoft' ? <MicrosoftLogo /> : <GoogleLogo />}
      <span>Continue with {provider === 'microsoft' ? 'Microsoft' : 'Google'}</span>
    </a>
  );
}

// ── Resend countdown ───────────────────────────────────────────────────────

export function useCountdown(seconds: number = RESEND_SECONDS): [number, () => void] {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(seconds)];
}

export const fmtWait = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** "Didn't get it? Resend" — "Resend in 0:SS" while waiting (§3.5). */
export function Resend({
  left,
  onResend,
  busy,
  label = 'Resend',
}: {
  left: number;
  onResend: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <div className="su-resend">
      <span>Didn’t get it?</span>
      <Button
        unstyled
        className="su-linkbtn"
        onClick={onResend}
        disabled={left > 0 || busy === true}
        data-testid="code-resend"
      >
        {left > 0 ? (
          <span className="su-resend__wait">{`${label} in ${fmtWait(left)}`}</span>
        ) : (
          label
        )}
      </Button>
    </div>
  );
}

// ── One-time code: one labelled input over six boxes (§4.5, §6) ────────────

export function CodeBoxes({
  id,
  label,
  value,
  onChange,
  error,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  onEnter?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, 5);
  return (
    <div className="su-field">
      <label className="su-label" htmlFor={id}>
        {label}
      </label>
      <div className={error !== undefined ? 'su-code su-code--error' : 'su-code'}>
        <div style={{ display: 'contents' }} aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={
                focused && i === active ? 'su-code__box su-code__box--active' : 'su-code__box'
              }
            >
              {value[i] ?? ''}
            </span>
          ))}
        </div>
        <Input
          unstyled
          id={id}
          className="su-code__input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && onEnter !== undefined) {
              e.preventDefault();
              onEnter();
            }
          }}
          data-testid="code-input"
          {...ariaFor(id, error, false)}
        />
      </div>
      {error !== undefined ? (
        <div className="su-error" id={errorId(id)} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
