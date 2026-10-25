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

/** Templates the organization can start from, or null when the feature is not available. */
export async function listTemplates(workspace: WorkspaceClient): Promise<SenderTemplate[] | null> {
  try {
    const out = await workspace.call('/v1/sign/sender/templates', 'get', {});
    return out.items.map((raw) => {
      const t = rec(raw);
      const vars = Array.isArray(t['variables']) ? (t['variables'] as unknown[]).map(rec) : [];
      return {
        id: String(t['template_id'] ?? ''),
        name: String(t['name'] ?? 'Template'),
        documentType: String(rec(t['document_type'])['name'] ?? ''),
        senderVariables: vars
          .filter((v) => v['source'] === 'SENDER')
          .map((v) => ({
            key: String(v['key'] ?? ''),
            label: String(v['label'] ?? v['key'] ?? ''),
            source: 'SENDER' as const,
          })),
      };
    });
  } catch (e) {
    if (isApiError(e) && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
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
