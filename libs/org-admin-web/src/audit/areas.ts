import type { AuditEventView } from './types';

// ORG-UX-1 (Directive v1.0 LOCKED §8.10; handoff §6.10) — the Org Audit "Area" filter,
// derived from the backend `category` (libs/identity categoryOf) and `event_type`.

export const AUDIT_AREAS = ['People', 'Access', 'Profile', 'Sites', 'Domain', 'Templates', 'Settings'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];
export const ALL_AREAS = 'All areas';

/**
 * The Area an event belongs to, or null for events that are not organization changes
 * (sign-in sessions) — the page is "Organization changes only".
 *   user → People · access → Access
 *   setting → Profile (identity.tenant_profile.updated) else Settings
 *   org → Sites (identity.site.*) else People (teams, reporting lines, client assignments)
 *   domain → Domain · template → Templates · system → Settings · session → (not shown)
 */
export function areaOf(e: Pick<AuditEventView, 'category' | 'event_type'>): AuditArea | null {
  switch (e.category) {
    case 'user':
      return 'People';
    case 'access':
      return 'Access';
    case 'setting':
      return e.event_type === 'identity.tenant_profile.updated' ? 'Profile' : 'Settings';
    case 'org':
      return e.event_type.startsWith('identity.site.') ? 'Sites' : 'People';
    case 'domain':
      return 'Domain';
    case 'template':
      return 'Templates';
    case 'system':
      return 'Settings';
    case 'session':
      return null;
    default:
      return null;
  }
}

/** "{action} *target*" — the backend summary split at its first ": " (target muted). */
export function splitChange(detail: string): { readonly action: string; readonly target: string | null } {
  const i = detail.indexOf(': ');
  if (i <= 0) return { action: detail, target: null };
  return { action: detail.slice(0, i), target: detail.slice(i + 2) };
}

/** When — local `YYYY-MM-DD HH:MM` (Plex Mono 12px). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Client-side search over the loaded pages (G11): who, the change text and the area. */
export function matchesSearch(e: AuditEventView, area: AuditArea, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return [e.actor.display, e.detail, area].some((s) => s.toLowerCase().includes(needle));
}
