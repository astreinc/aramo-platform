import type { ReactNode } from 'react';

// D-ORG-3 — the DOMAIN-NEUTRAL chip atoms, moved from apps/ats-web/src/ui/pills.tsx
// (move-not-fork) so libs/org-admin-web renders the same status/tag grammar.
// The ATS-domain projections (StagePill / BandPill / ConstraintChip) stay in
// ats-web; it re-exports these from its ui/ barrel so call-sites are unchanged.

export type PillTone =
  | 'neutral'
  | 'brand'
  | 'info'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'hot'
  // PLATFORM-UX-1 U-0 (directive R-4): additive low-emphasis grey for
  // terminal/retired states (Closed, Released, Replaced). Platform Admin.dc.html
  // TONE.muted = ['#66717B', '#F0F2F4'].
  | 'muted';

interface StatusPillProps {
  readonly tone: PillTone;
  /** Render a leading current-colour dot (the mockup "Open ·" affordance). */
  readonly dot?: boolean;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}

// Generic status chip — muted same-family fill. The semantic tone is the
// caller's decision (mapping helpers live with each surface so the design-
// system atom stays domain-neutral).
export function StatusPill({ tone, dot, icon, children }: StatusPillProps) {
  return (
    <span className={`rc-pill rc-pill--${tone}${dot ? ' rc-pill__dot' : ''}`}>
      {icon}
      {children}
    </span>
  );
}

interface TagProps {
  readonly children: ReactNode;
}

export function Tag({ children }: TagProps) {
  return <span className="rc-tag">{children}</span>;
}

interface TagListProps {
  readonly tags: readonly string[];
  /** Max chips before collapsing the remainder into a "+N" tag. */
  readonly max?: number;
}

// Label chips with overflow. Presentational only — splitting freetext into
// tags is the caller's job.
export function TagList({ tags, max = 3 }: TagListProps) {
  const shown = tags.slice(0, max);
  const overflow = tags.length - shown.length;
  return (
    <span className="rc-tags">
      {shown.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
      {overflow > 0 ? <Tag>{`+${overflow}`}</Tag> : null}
    </span>
  );
}
