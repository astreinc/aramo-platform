// Role binding for a template with signing roles (Amendment M-A6 §3.5; M-A4 §6.4 "Multi-
// role binding arrives with the template amendment"). Pure: the roles come from the
// template list exactly as the backend returned them (role order), the sender picks one
// person per role, and this module builds the from-template `recipients` / `cc` body.
//
// The checks here mirror the server's rules so the sender sees them before the request
// (every SIGNER role bound exactly once, distinct emails across signing and copy
// recipients, the server's limits, a valid name and email). They never replace the
// server: whatever it refuses is shown with its own reason (roleRefusal), and a
// template_roles_changed refusal asks the caller to reload the template list.
import { isApiError } from '../../api/errors';
import { FEATURES } from '../../config/features';
import { isValidEmail } from '../contacts/contactsApi';
import {
  MAX_RECIPIENTS,
  MESSAGE_MAX,
  isCopyRecipient,
  type RoutingMode,
  type ServerEnvelope,
} from '../send/draftModel';
import type {
  RoleBindingRequest,
  SenderTemplate,
  TemplateRole,
  TemplateSigning,
} from '../send/templates';
import type { SendStep } from '../../state/draftStore';
import { libraryRefusal } from './templatesModel';

/** The server's copy-recipient limit (sender-templates.service.ts MAX_COPY_RECIPIENTS). */
export const MAX_COPY_RECIPIENTS = 10;
const NAME_MAX = 200;

export interface RolePerson {
  readonly name: string;
  readonly email: string;
}

export interface RoleBindingState {
  /** The person bound to each role, keyed by role_key (null = not bound yet). */
  readonly people: Readonly<Record<string, RolePerson | null>>;
  readonly routingMode: RoutingMode;
  readonly message: string;
}

export type RoleBindResult = 'bound' | 'duplicate' | 'unknown_role';

export type RoleIssue =
  | { readonly kind: 'role_unbound'; readonly roleKey: string; readonly label: string }
  | { readonly kind: 'name_required'; readonly roleKey: string; readonly label: string }
  | { readonly kind: 'email_invalid'; readonly roleKey: string; readonly label: string }
  | { readonly kind: 'duplicate_email'; readonly email: string }
  | { readonly kind: 'too_many_signers' }
  | { readonly kind: 'too_many_copy_recipients' }
  | { readonly kind: 'message_too_long' };

export const ROLE_KIND_LABEL: Record<TemplateRole['kind'], string> = {
  SIGNER: 'Signer',
  CC: 'Gets a copy',
};

export const ROLES_CHANGED =
  'This template changed while you were filling it in. The list was refreshed; pick it again.';
export const ALREADY_BOUND = 'This person already has another role on this envelope.';

/**
 * Whether "Use" binds roles: only for a template the backend lists WITH signing roles,
 * while the multi-role feature is on. A template without roles keeps the single-signer
 * path (the sender-variable form) unchanged.
 */
export function usesRoleBinding(
  template: Pick<SenderTemplate, 'signing'>,
  enabled: boolean = FEATURES.multiRoleTemplates,
): boolean {
  return enabled && template.signing !== null && template.signing.roles.length > 0;
}

/** The start state: nobody bound, the template's routing and default message. */
export function initialRoleBinding(signing: TemplateSigning): RoleBindingState {
  return {
    people: Object.fromEntries(signing.roles.map((r) => [r.roleKey, null])),
    routingMode: signing.routingMode,
    message: signing.defaultMessage ?? '',
  };
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Bind a person to a role. Refuses an email another role already has (distinct emails). */
export function bindPerson(
  state: RoleBindingState,
  signing: TemplateSigning,
  roleKey: string,
  person: RolePerson,
): { readonly state: RoleBindingState; readonly result: RoleBindResult } {
  if (!signing.roles.some((r) => r.roleKey === roleKey)) return { state, result: 'unknown_role' };
  const taken = Object.entries(state.people).some(
    ([k, p]) => k !== roleKey && p !== null && sameEmail(p.email, person.email),
  );
  if (taken) return { state, result: 'duplicate' };
  const bound = { name: person.name.trim(), email: person.email.trim() };
  return { state: { ...state, people: { ...state.people, [roleKey]: bound } }, result: 'bound' };
}

export function clearRole(state: RoleBindingState, roleKey: string): RoleBindingState {
  return { ...state, people: { ...state.people, [roleKey]: null } };
}

/**
 * "Assign to me" for a SIGNER role. The from-template API takes no assign_to_me flag, so
 * the signed-in user's name and email are bound like any other person (the same
 * distinct-email check applies).
 */
export function assignMe(
  state: RoleBindingState,
  signing: TemplateSigning,
  roleKey: string,
  me: RolePerson,
): { readonly state: RoleBindingState; readonly result: RoleBindResult } {
  const role = signing.roles.find((r) => r.roleKey === roleKey);
  if (!role || role.kind !== 'SIGNER') return { state, result: 'unknown_role' };
  return bindPerson(state, signing, roleKey, me);
}

export function setRouting(state: RoleBindingState, routingMode: RoutingMode): RoleBindingState {
  return { ...state, routingMode };
}

export function setMessage(state: RoleBindingState, message: string): RoleBindingState {
  return { ...state, message };
}

/** The routing control is shown only when there is an order to choose (2+ signer roles). */
export function routingEditable(signing: TemplateSigning): boolean {
  return signing.roles.filter((r) => r.kind === 'SIGNER').length > 1;
}

/** Everything the server would refuse that the app can see first, in role order. */
export function roleBindingIssues(signing: TemplateSigning, state: RoleBindingState): RoleIssue[] {
  const out: RoleIssue[] = [];
  const seen = new Set<string>();
  let signers = 0;
  let copies = 0;
  for (const role of signing.roles) {
    const p = state.people[role.roleKey] ?? null;
    if (p === null) {
      // CC roles are optional; every SIGNER role is bound exactly once.
      if (role.kind === 'SIGNER') out.push({ kind: 'role_unbound', roleKey: role.roleKey, label: role.label });
      continue;
    }
    if (role.kind === 'SIGNER') signers += 1;
    else copies += 1;
    const name = p.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      out.push({ kind: 'name_required', roleKey: role.roleKey, label: role.label });
    }
    if (!isValidEmail(p.email)) {
      out.push({ kind: 'email_invalid', roleKey: role.roleKey, label: role.label });
      continue;
    }
    const key = p.email.trim().toLowerCase();
    if (seen.has(key)) out.push({ kind: 'duplicate_email', email: p.email.trim() });
    seen.add(key);
  }
  if (signers > MAX_RECIPIENTS) out.push({ kind: 'too_many_signers' });
  if (copies > MAX_COPY_RECIPIENTS) out.push({ kind: 'too_many_copy_recipients' });
  if (state.message.trim().length > MESSAGE_MAX) out.push({ kind: 'message_too_long' });
  return out;
}

export function issueText(issue: RoleIssue): string {
  switch (issue.kind) {
    case 'role_unbound':
      return `Choose a person for ${issue.label}.`;
    case 'name_required':
      return `Enter a name for ${issue.label}.`;
    case 'email_invalid':
      return `Enter a valid email for ${issue.label}.`;
    case 'duplicate_email':
      return `${issue.email} is on this envelope twice. Each role needs a different person.`;
    case 'too_many_signers':
      return `An envelope can have up to ${MAX_RECIPIENTS} signers.`;
    case 'too_many_copy_recipients':
      return `An envelope can have up to ${MAX_COPY_RECIPIENTS} copy recipients.`;
    case 'message_too_long':
      return `The message can be at most ${MESSAGE_MAX} characters.`;
  }
}

/**
 * The from-template binding: SIGNER roles in role order as `recipients` (signing order =
 * role order, server side), bound CC roles as `cc`, the routing mode, and the message
 * (an emptied message is sent as null: no message). Null while any issue remains.
 */
export function roleBindingRequest(
  signing: TemplateSigning,
  state: RoleBindingState,
): RoleBindingRequest | null {
  if (roleBindingIssues(signing, state).length > 0) return null;
  const wire = (r: TemplateRole) => {
    const p = state.people[r.roleKey]!;
    return { role_key: r.roleKey, name: p.name.trim(), email: p.email.trim() };
  };
  const message = state.message.trim();
  return {
    recipients: signing.roles.filter((r) => r.kind === 'SIGNER').map(wire),
    cc: signing.roles.filter((r) => r.kind === 'CC' && state.people[r.roleKey]).map(wire),
    routing_mode: state.routingMode,
    message: message.length > 0 ? message : null,
  };
}

/** Copy for the server's from-template role refusals (M-A6 §3.5 details.reason). */
const ROLE_REFUSALS: Record<string, string> = {
  template_roles_changed: ROLES_CHANGED,
  template_has_roles: 'This template has signing roles. Choose a person for each role.',
  template_has_no_roles: 'This template has no signing roles any more. Pick it again from the list.',
  unknown_role: 'A role on this template no longer exists. Pick the template again.',
  role_not_signer: 'A role on this template changed. Pick the template again.',
  role_not_cc: 'A role on this template changed. Pick the template again.',
  role_bound_twice: 'Each role can have only one person.',
  role_unbound: 'Choose a person for every signing role.',
  duplicate_email: 'Each role needs a different person: an email is on this envelope twice.',
  too_many_signers: `An envelope can have up to ${MAX_RECIPIENTS} signers.`,
  too_many_copy_recipients: `An envelope can have up to ${MAX_COPY_RECIPIENTS} copy recipients.`,
  copy_recipients_unavailable: 'Copy recipients aren’t available yet. Leave the copy roles empty.',
  routing_mode_invalid: 'Choose how people sign: any order or in order.',
  name_required: 'Every person needs a name.',
  email_invalid: 'Every person needs a valid email address.',
};

export const ROLE_USE_FAILED = 'The template couldn’t be used. Try again.';

/**
 * The message for a refused role-bound "Use template", and whether the template list
 * must be reloaded (the roles the sender bound are no longer the template's roles).
 */
export function roleRefusal(e: unknown): { readonly message: string; readonly refreshList: boolean } {
  if (!isApiError(e)) return { message: ROLE_USE_FAILED, refreshList: false };
  const own = ROLE_REFUSALS[e.reason];
  if (own) {
    const refresh = ['template_roles_changed', 'template_has_no_roles', 'unknown_role', 'role_not_signer', 'role_not_cc'];
    return { message: own, refreshList: refresh.includes(e.reason) };
  }
  if (e.status === 403 || e.status === 404) return { message: libraryRefusal(e), refreshList: e.status === 404 };
  return { message: ROLE_USE_FAILED, refreshList: false };
}

/**
 * Where the Send flow opens after a role-bound draft: **Review** when the server bound
 * everything (a document, at least one signer, and every signer has a signature field
 * the template placed), otherwise **Recipients** (step 2, as the template path without
 * roles does), so the sender sees who is still missing a field.
 */
export function landingStep(env: Pick<ServerEnvelope, 'documents' | 'recipients' | 'fields'>): SendStep {
  const signers = env.recipients.filter((r) => !isCopyRecipient(r));
  const ready =
    env.documents.length > 0 &&
    signers.length > 0 &&
    signers.every((r) => env.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE'));
  return ready ? 'review' : 'recipients';
}
