import { ESIGN_SCOPE, type EsignScope } from '../dto/esign-permissions.js';

// Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — custom roles and
// permissions. An organization defines its own Sign roles, composed ONLY from the existing
// Sign scopes. This file is the single, pure policy every write and every read applies.
//
//   Composable set  = every `sign:*` key in ESIGN_SCOPE EXCEPT sign:billing:manage. Billing
//                     administration belongs to the organization owner alone (ROLES-1 §3.4:
//                     held only by tenant_owner), so no custom role may carry it. Platform,
//                     ATS, organization and Documents scopes are never composable — a custom
//                     role cannot name them, and the database CHECK refuses them too.
//   Anti-escalation = a custom role may never hold a scope its creator (or editor) does not
//                     hold, and a member may only be given a custom role whose every scope the
//                     assigning actor holds. Authority can only be handed down, never widened.
//   Resolution      = the scope keys a custom role contributes are re-filtered through the
//                     composable set at read time (defence in depth against a tampered row).

const S = ESIGN_SCOPE;
export const SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES: readonly EsignScope[] = [
  S.ENVELOPE_READ,
  S.ENVELOPE_READ_ALL,
  S.ENVELOPE_CREATE,
  S.ENVELOPE_SEND,
  S.ENVELOPE_MANAGE_ALL,
  S.CONTACT_READ,
  S.REPORT_READ,
  S.MEMBER_MANAGE,
  S.SETTINGS_MANAGE,
  S.INTEGRATION_MANAGE,
];

const COMPOSABLE: ReadonlySet<string> = new Set<string>(SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES);

export const SIGN_CUSTOM_ROLE_NAME_MAX = 60;
export const SIGN_CUSTOM_ROLE_DESCRIPTION_MAX = 500;
// A bounded number of roles per organization (an administrative surface, not a data store).
export const SIGN_CUSTOM_ROLES_PER_TENANT_MAX = 50;

export function isComposableSignScope(key: string): key is EsignScope {
  return COMPOSABLE.has(key);
}

/** Read-time filter: only composable Sign scopes ever leave a custom role. */
export function composableScopesOf(keys: readonly string[]): EsignScope[] {
  return [...new Set(keys)].filter(isComposableSignScope).sort();
}

export type CustomRoleScopeRefusal =
  | { ok: false; reason: 'scope_keys_required' }
  | { ok: false; reason: 'scope_not_composable'; scopes: string[] }
  | { ok: false; reason: 'scope_exceeds_actor'; scopes: string[] };

/**
 * The anti-escalation guard for a role's scope set (create and edit). `requested` must be a
 * non-empty set of composable Sign scopes, every one of which the actor holds. Returns the
 * normalized (deduplicated, sorted) set.
 */
export function checkCustomRoleScopes(
  requested: readonly unknown[],
  actorScopes: Iterable<string>,
): { ok: true; scopes: EsignScope[] } | CustomRoleScopeRefusal {
  if (requested.length === 0) return { ok: false, reason: 'scope_keys_required' };
  const nonString = requested.filter((k) => typeof k !== 'string');
  if (nonString.length > 0) return { ok: false, reason: 'scope_not_composable', scopes: nonString.map((k) => String(k)) };
  const keys = [...new Set(requested as string[])];
  const notComposable = keys.filter((k) => !isComposableSignScope(k)).sort();
  if (notComposable.length > 0) return { ok: false, reason: 'scope_not_composable', scopes: notComposable };
  const held = new Set(actorScopes);
  const exceeds = keys.filter((k) => !held.has(k)).sort();
  if (exceeds.length > 0) return { ok: false, reason: 'scope_exceeds_actor', scopes: exceeds };
  return { ok: true, scopes: keys.sort() as EsignScope[] };
}

/** The assignment guard: the actor must hold every scope the role grants. */
export function scopesActorLacks(roleScopes: readonly string[], actorScopes: Iterable<string>): string[] {
  const held = new Set(actorScopes);
  return [...new Set(roleScopes)].filter((k) => !held.has(k)).sort();
}

export type CustomRoleTextRefusal = { ok: false; reason: 'name_invalid' | 'description_invalid' };

export function normalizeCustomRoleText(
  name: unknown,
  description: unknown,
): { ok: true; name: string; description: string | null } | CustomRoleTextRefusal {
  if (typeof name !== 'string') return { ok: false, reason: 'name_invalid' };
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length < 1 || n.length > SIGN_CUSTOM_ROLE_NAME_MAX) return { ok: false, reason: 'name_invalid' };
  // Control characters are never part of a role name.
  if ([...n].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return { ok: false, reason: 'name_invalid' };
  if (description === undefined || description === null) return { ok: true, name: n, description: null };
  if (typeof description !== 'string') return { ok: false, reason: 'description_invalid' };
  const d = description.trim();
  if (d.length > SIGN_CUSTOM_ROLE_DESCRIPTION_MAX) return { ok: false, reason: 'description_invalid' };
  return { ok: true, name: n, description: d.length === 0 ? null : d };
}
