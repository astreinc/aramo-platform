// "Or start from a template" (handoff §4.6; directive §5 "Templates", §7 C-17). The
// source exists only while the backend reports the `sign.templates` capability as
// available (GET /v1/sign/sender/context `features.templates`) and the session may read
// templates (`permissions.templates`). While it is not available the source is hidden,
// and nothing here activates it: every template route then answers
// ESIGN_FEATURE_NOT_AVAILABLE (403), which also hides the source. No roles are
// invented: a template brings its documents and the at-most-one signer the backend adds.
import { isApiError } from '../../api/errors';
import { etagFor, type WorkspaceClient } from '../../api/workspaceClient';
import { parseEnvelope } from './draftModel';
import type { Versioned } from './senderApi';

export interface TemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly source: 'ORGANIZATION' | 'SENDER';
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

/** Create a DRAFT from a template (idempotent on `idempotencyKey` for the render). */
export async function createFromTemplate(
  workspace: WorkspaceClient,
  input: {
    readonly templateId: string;
    readonly values: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  },
): Promise<Versioned> {
  const out = await workspace.call('/v1/sign/sender/envelopes/from-template', 'post', {
    body: {
      template_id: input.templateId,
      values: { ...input.values },
      idempotency_key: input.idempotencyKey,
    },
  });
  const env = parseEnvelope(rec(out)['envelope']);
  if (!env.id || env.revision === null) throw new Error('the server returned no envelope');
  return { env, etag: etagFor({ id: env.id, revision: env.revision }) };
}
