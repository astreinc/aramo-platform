import { ESIGN_ROLE_PERMISSIONS, type EsignRoleKey } from '@aramo/identity';

// Sign Unified Product S-4 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.4.2, mandatory refinement A).
//
//   Effective Sign permissions = Principal authority ∩ Installation grants ∩ Delegated scope
//
// Principal authority is ONE of:
//   - USER mode: the user's own Sign permissions (resolved server-side for the
//     `sign` consumer), PLUS — for a FIRST_PARTY application only — the
//     application's narrow delegation profile when the user holds the
//     application's required platform permission (also resolved server-side,
//     e.g. ATS `document:execute`). This is how an ATS recruiter sends through
//     the approved installation without a permanent Sign role.
//   - APPLICATION mode: the installation's integration role (set by a Sign admin),
//     narrowed by a tenant-approved mapping of the external role the platform
//     asserts — and an assertion is honoured only when the installation is
//     authorized to assert roles. Unmapped or untrusted assertions fail closed.
// A platform's claimed role never creates Sign authority: every term is an
// intersection, so nothing outside Sign's own grants can widen the result.

export type IntegrationMode = 'USER' | 'APPLICATION';

export interface ApplicationView {
  key: string;
  kind: 'FIRST_PARTY' | 'THIRD_PARTY' | string;
  status: string;
  requested_permissions: readonly string[];
  modes: readonly string[];
  assertable_roles: readonly string[];
  delegation_profile: readonly string[];
  delegation_required_scope: string | null;
}

export interface InstallationView {
  status: string;
  granted_permissions: readonly string[];
  modes: readonly string[];
  integration_role: string | null;
  role_assertion_enabled: boolean;
}

export type AuthorityDenial =
  | 'application_disabled'
  | 'installation_revoked'
  | 'mode_not_allowed'
  | 'role_assertion_not_allowed'
  | 'role_unmapped'
  | 'no_integration_role'
  | 'scope_not_granted'
  | 'no_authority';

export type AuthorityResult = { ok: true; scopes: string[] } | { ok: false; reason: AuthorityDenial };

const intersect = (a: readonly string[], b: readonly string[]): string[] => {
  const s = new Set(b);
  return [...new Set(a)].filter((x) => s.has(x)).sort();
};

const rolePermissions = (role: string | null | undefined): readonly string[] =>
  role !== null && role !== undefined && role in ESIGN_ROLE_PERMISSIONS ? ESIGN_ROLE_PERMISSIONS[role as EsignRoleKey] : [];

export function effectiveAuthority(input: {
  mode: IntegrationMode;
  application: ApplicationView;
  installation: InstallationView;
  // Requested (delegated) scope; undefined = everything the other two terms allow.
  requested?: readonly string[];
  // USER mode — server-resolved.
  user_sign_scopes?: readonly string[];
  user_platform_scopes?: readonly string[];
  // APPLICATION mode — the asserted external role and the installation's mappings.
  external_role?: string;
  role_mappings?: ReadonlyMap<string, string>;
}): AuthorityResult {
  const { application: app, installation: inst, mode } = input;
  if (app.status !== 'ACTIVE') return { ok: false, reason: 'application_disabled' };
  if (inst.status !== 'ACTIVE') return { ok: false, reason: 'installation_revoked' };
  if (!app.modes.includes(mode) || !inst.modes.includes(mode)) return { ok: false, reason: 'mode_not_allowed' };

  let principal: string[];
  if (mode === 'USER') {
    principal = [...(input.user_sign_scopes ?? []).filter((s) => s.startsWith('sign:'))];
    const delegated =
      app.kind === 'FIRST_PARTY' &&
      app.delegation_required_scope !== null &&
      (input.user_platform_scopes ?? []).includes(app.delegation_required_scope);
    if (delegated) principal = [...principal, ...app.delegation_profile];
  } else {
    if (inst.integration_role === null) return { ok: false, reason: 'no_integration_role' };
    principal = [...rolePermissions(inst.integration_role)];
    if (input.external_role !== undefined) {
      if (!inst.role_assertion_enabled || !app.assertable_roles.includes(input.external_role)) {
        return { ok: false, reason: 'role_assertion_not_allowed' };
      }
      const mapped = input.role_mappings?.get(input.external_role);
      if (mapped === undefined) return { ok: false, reason: 'role_unmapped' };
      principal = intersect(principal, rolePermissions(mapped));
    }
  }

  // Installation grants are themselves bounded by what the application requested.
  const grants = intersect(inst.granted_permissions, app.requested_permissions);
  let scopes = intersect(principal, grants);
  if (input.requested !== undefined) {
    const notGranted = input.requested.filter((s) => !scopes.includes(s));
    if (notGranted.length > 0) return { ok: false, reason: 'scope_not_granted' };
    scopes = intersect(scopes, input.requested);
  }
  if (scopes.length === 0) return { ok: false, reason: 'no_authority' };
  return { ok: true, scopes };
}
