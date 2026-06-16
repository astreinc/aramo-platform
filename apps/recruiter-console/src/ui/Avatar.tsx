import type { ReactNode } from 'react';

import { IconFlame } from './icons';

export type AvatarSize = 'sm' | 'md' | 'lg';

interface AvatarProps {
  /** Full name; initials are derived when `initials` is not given. */
  readonly name?: string;
  /** Explicit initials override (e.g. for entities without a person name). */
  readonly initials?: string;
  readonly size?: AvatarSize;
  /** Background colour; deterministically derived from the name when omitted. */
  readonly color?: string;
}

// Deterministic, calm avatar palette (confident-blue adjacent). The hash
// keeps a given name on a stable colour without storing one.
const PALETTE = [
  '#3E7C70',
  '#7A5C9E',
  '#B5763B',
  '#6B8E5A',
  '#9E5C5C',
  '#4A6FA5',
  '#8A5C7A',
];

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length] ?? '#3e7c70';
}

export function Avatar({ name, initials, size = 'md', color }: AvatarProps) {
  const text = initials ?? (name ? initialsOf(name) : '?');
  const bg = color ?? colorFor(name ?? text);
  return (
    <span
      className={`rc-av rc-av--${size}`}
      style={{ background: bg }}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

interface EntityCellProps {
  readonly name: string;
  readonly subtitle?: ReactNode;
  readonly hot?: boolean;
  readonly size?: AvatarSize;
  readonly color?: string;
}

// Avatar + name (+ optional subtitle and hot flag) — the recurring "entity
// cell" used in talent / pipeline tables. Composition over the atoms.
export function EntityCell({
  name,
  subtitle,
  hot = false,
  size = 'md',
  color,
}: EntityCellProps) {
  return (
    <div className="rc-ent">
      <Avatar name={name} size={size} color={color} />
      <div>
        <div className="rc-ent__nm">
          {name}
          {hot ? <IconFlame aria-label="Hot" /> : null}
        </div>
        {subtitle != null ? <div className="rc-ent__rl">{subtitle}</div> : null}
      </div>
    </div>
  );
}
