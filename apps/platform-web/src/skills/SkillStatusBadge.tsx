import type { SkillStatus } from './skills-api';

// A minimal active/inactive status pill for the skill governance surfaces. The
// taxonomy is platform-global and counts-only — this is a plain state marker, never
// a rating.
export function SkillStatusBadge({ status }: { readonly status: SkillStatus | string }) {
  const active = status === 'active';
  return (
    <span
      className="pw-skill-badge"
      data-active={active ? 'true' : 'false'}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  );
}
