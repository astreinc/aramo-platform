// "Or start from a template" (handoff §4.6; directive §5 "Templates", §7 C-17). The
// source exists only while the backend reports the `sign.templates` capability as
// available (GET /v1/sign/sender/context `features.templates`) and the session may read
// templates (`permissions.templates`). While it is not available the source is hidden,
// and nothing here activates it: every template route then answers
// ESIGN_FEATURE_NOT_AVAILABLE (403), which also hides the source. No roles are
// invented: a template without signing roles brings its documents and the at-most-one
// signer the backend adds; a template WITH roles (M-A6 §3.2) is bound role by role
// (`recipients` / `cc`, M-A6 §3.5) exactly as the backend lists them.
import { isApiError } from '../../api/errors';
import { etagFor, type WorkspaceClient } from '../../api/workspaceClient';
import { parseEnvelope, type RoutingMode } from './draftModel';
import type { Versioned } from './senderApi';

export interface TemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly source: 'ORGANIZATION' | 'SENDER';
}

/** A template signing role (M-A6 §3.2), as the backend lists it. */
export interface TemplateRole {
  readonly roleKey: string;
  readonly label: string;
  readonly kind: 'SIGNER' | 'CC';
  readonly order: number;
}

/** The template's `signing` member (M-A6 §3.2); roles in role order. */
export interface TemplateSigning {
  readonly roles: readonly TemplateRole[];
  readonly routingMode: RoutingMode;
  readonly defaultSubject: string | null;
  readonly defaultMessage: string | null;
}

export interface SenderTemplate {
  readonly id: string;
  readonly name: string;
  readonly documentType: string;
  /** The template's description, when the backend returns one. */
  readonly description: string | null;
  /** The resolved template version, when the backend returns it. */
  readonly versionNumber: number | null;
  /** The values the sender fills in. */
  readonly senderVariables: readonly TemplateVariable[];
  /** M-A6 §3.7 list metadata — each null when the backend did not return it. */
  readonly category: string | null;
  readonly signerRoleCount: number | null;
  readonly ccRoleCount: number | null;
  readonly documentCount: number | null;
  readonly routingMode: RoutingMode | null;
  /** The signing roles (M-A6 §3.2), or null for a template without roles. */
  readonly signing: TemplateSigning | null;
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const routing = (v: unknown): RoutingMode | null =>
  v === 'PARALLEL' || v === 'SEQUENTIAL' ? v : null;
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;

/** The template's signing roles, or null when it has none (an empty list is none). */
export function parseSigning(raw: unknown): TemplateSigning | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const roles = (Array.isArray(o['roles']) ? (o['roles'] as unknown[]) : [])
    .map(rec)
    .filter((r) => typeof r['role_key'] === 'string' && (r['kind'] === 'SIGNER' || r['kind'] === 'CC'))
    .map((r) => ({
      roleKey: r['role_key'] as string,
      label: text(r['label']) ?? (r['role_key'] as string),
      kind: r['kind'] as 'SIGNER' | 'CC',
      order: typeof r['order'] === 'number' ? r['order'] : 0,
    }))
    .sort((a, b) => a.order - b.order);
  if (roles.length === 0) return null;
  return {
    roles,
    routingMode: routing(o['routing_mode']) ?? 'PARALLEL',
    defaultSubject: text(o['default_subject']),
    defaultMessage: text(o['default_message']),
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** The backend's availability signal (never derived on the device). */
export function templatesAvailable(context: unknown): boolean {
  const c = rec(context);
  return rec(c['features'])['templates'] === true && rec(c['permissions'])['templates'] === true;
}

function parseTemplate(raw: unknown): SenderTemplate {
  const t = rec(raw);
  const vars = Array.isArray(t['variables']) ? (t['variables'] as unknown[]).map(rec) : [];
  const description = typeof t['description'] === 'string' ? t['description'].trim() : '';
  const version = t['version_number'];
  return {
    id: String(t['template_id'] ?? ''),
    name: String(t['name'] ?? 'Template'),
    documentType: String(rec(t['document_type'])['name'] ?? ''),
    description: description || null,
    versionNumber: typeof version === 'number' && Number.isFinite(version) ? version : null,
    senderVariables: vars
      .filter((v) => v['source'] === 'SENDER')
      .map((v) => ({
        key: String(v['key'] ?? ''),
        label: String(v['label'] ?? v['key'] ?? ''),
        source: 'SENDER' as const,
      })),
    category: text(t['category']),
    signerRoleCount: count(t['signer_role_count']),
    ccRoleCount: count(t['cc_role_count']),
    documentCount: count(t['document_count']),
    routingMode: routing(t['routing_mode']),
    signing: parseSigning(t['signing']),
  };
}

/**
 * The template library as the backend answers it (M-A4 §6.4):
 *   - `ok`: the templates, plus the document types it reports as unavailable right now
 *     (their reason codes, never swapped for another template);
 *   - `unavailable`: the route refused (403/404), with the server's reason.
 */
export type TemplateLibrary =
  | {
      readonly kind: 'ok';
      readonly items: readonly SenderTemplate[];
      readonly unavailable: readonly { readonly documentTypeId: string; readonly reason: string }[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly code: string };

export async function loadTemplateLibrary(workspace: WorkspaceClient): Promise<TemplateLibrary> {
  try {
    const out = await workspace.call('/v1/sign/sender/templates', 'get', {});
    const unavailable = Array.isArray(out.unavailable) ? (out.unavailable as unknown[]) : [];
    return {
      kind: 'ok',
      items: out.items.map(parseTemplate),
      unavailable: unavailable.map(rec).map((u) => ({
        documentTypeId: String(u['document_type_id'] ?? ''),
        reason: String(u['reason'] ?? ''),
      })),
    };
  } catch (e) {
    if (isApiError(e) && (e.status === 403 || e.status === 404)) {
      return { kind: 'unavailable', reason: e.reason, code: e.code };
    }
    throw e;
  }
}

/** Templates the organization can start from, or null when the feature is not available. */
export async function listTemplates(workspace: WorkspaceClient): Promise<SenderTemplate[] | null> {
  const lib = await loadTemplateLibrary(workspace);
  return lib.kind === 'ok' ? [...lib.items] : null;
}

/** One person bound to a template role (M-A6 §3.5). */
export interface RoleBindingWire {
  readonly role_key: string;
  readonly name: string;
  readonly email: string;
}

/** The role binding of a from-template request (mutually exclusive with `signer`). */
export interface RoleBindingRequest {
  readonly recipients: readonly RoleBindingWire[];
  readonly cc: readonly RoleBindingWire[];
  readonly routing_mode: RoutingMode;
  readonly message: string | null;
}

/**
 * Create a DRAFT from a template (idempotent on `idempotencyKey` for the render). With
 * `binding`, a template with roles is bound role by role (M-A6 §3.5); without it, the
 * template-without-roles path is unchanged.
 */
export async function createFromTemplate(
  workspace: WorkspaceClient,
  input: {
    readonly templateId: string;
    readonly values: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly binding?: RoleBindingRequest;
  },
): Promise<Versioned> {
  const b = input.binding;
  const out = await workspace.call('/v1/sign/sender/envelopes/from-template', 'post', {
    body: {
      template_id: input.templateId,
      values: { ...input.values },
      idempotency_key: input.idempotencyKey,
      ...(b
        ? {
            recipients: b.recipients.map((r) => ({ ...r })),
            // CC roles are optional: an empty list is not sent.
            ...(b.cc.length > 0 ? { cc: b.cc.map((r) => ({ ...r })) } : {}),
            routing_mode: b.routing_mode,
            message: b.message,
          }
        : {}),
    },
  });
  const env = parseEnvelope(rec(out)['envelope']);
  if (!env.id || env.revision === null) throw new Error('the server returned no envelope');
  return { env, etag: etagFor({ id: env.id, revision: env.revision }) };
}
