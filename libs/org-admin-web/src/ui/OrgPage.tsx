import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { useMe } from '../me-api';
import { ORG_SECTION_INTRO, orgSectionByKey, type OrgSectionKey } from '../sections';

import './org-ui.css';

// ORG-UX-1 — the shared Organization page kit (handoff §4 tokens; org-ui.css).

/** Page header: H1 = the section name, the exact intro line, optional actions on the right. */
export function OrgPageHeader({ section, actions }: { readonly section: OrgSectionKey; readonly actions?: ReactNode }) {
  const me = useMe();
  const org = me?.tenant.display_name ?? 'your organization';
  return (
    <header className="ox-head">
      <div className="ox-head__text">
        <h1>{orgSectionByKey(section).label}</h1>
        <p>{ORG_SECTION_INTRO[section].replace('{Org}', org)}</p>
      </div>
      {actions !== undefined ? <div className="ox-head__actions">{actions}</div> : null}
    </header>
  );
}

/**
 * Modal — handoff §4 / §8: centred, role="dialog" + aria-modal, keyboard focus kept inside,
 * Esc closes, focus returns to the opener (Radix Dialog primitive), close × top right,
 * footer buttons right-aligned.
 */
export function OrgModal({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  testId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ox-modal__overlay" />
        <RadixDialog.Content className="ox-modal" aria-modal="true" data-testid={testId} aria-describedby={subtitle === undefined ? undefined : 'ox-modal-sub'}>
          <div className="ox-modal__head">
            <div>
              <RadixDialog.Title className="ox-modal__title">{title}</RadixDialog.Title>
              {subtitle !== undefined ? (
                <RadixDialog.Description id="ox-modal-sub" className="ox-modal__sub">
                  {subtitle}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close className="ox-modal__close" aria-label="Close">
              ×
            </RadixDialog.Close>
          </div>
          <div className="ox-modal__body">{children}</div>
          {footer !== undefined ? <div className="ox-modal__foot">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Accessible checkbox (role="checkbox", aria-checked) — handoff §6.3 / §8. */
export function OrgCheck({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  readonly checked: boolean | 'mixed';
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="ox-check"
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(checked !== true)}
    >
      {checked === true ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : checked === 'mixed' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 12h12" />
        </svg>
      ) : null}
    </button>
  );
}

/** Initials avatar, tint rotated by a stable key (4 tints). */
export function OrgAvatar({ name, seed, size = 30 }: { readonly name: string; readonly seed: string; readonly size?: number }) {
  const initials =
    name
      .split(/[\s@._-]+/)
      .filter((p) => p.length > 0)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (
    <span className={`ox-avatar ox-avatar--${h % 4}`} style={size !== 30 ? { width: size, height: size, fontSize: Math.round(size * 0.38) } : undefined} aria-hidden="true">
      {initials}
    </span>
  );
}

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
