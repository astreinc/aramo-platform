import type { CSSProperties } from 'react';

// Tenant lifecycle status → badge tone (directive §6): PROVISIONED neutral,
// ACTIVE positive, SUSPENDED warning, OFFBOARDING/CLOSED muted. Rendered locally
// — fe-foundation's pills were NOT extracted (need-not-inventory), so a small
// token-styled badge here duplicates no fe-foundation export.

type Tone = 'neutral' | 'positive' | 'warning' | 'muted';

const TONE_BY_STATUS: Record<string, Tone> = {
  PROVISIONED: 'neutral',
  ACTIVE: 'positive',
  SUSPENDED: 'warning',
  OFFBOARDING: 'muted',
  CLOSED: 'muted',
};

const TONE_STYLE: Record<Tone, CSSProperties> = {
  positive: { background: 'var(--ok-tint)', color: 'var(--ok)' },
  warning: { background: 'var(--warn-tint)', color: 'var(--warn)' },
  neutral: { background: 'var(--info-tint)', color: 'var(--info)' },
  muted: { background: 'var(--surface-2)', color: 'var(--muted)' },
};

export function StatusBadge({ status }: { readonly status: string }) {
  const tone = TONE_BY_STATUS[status] ?? 'muted';
  return (
    <span
      className="pw-badge"
      style={{
        ...TONE_STYLE[tone],
        display: 'inline-block',
        padding: '2px 9px',
        borderRadius: '999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
}
