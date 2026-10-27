// The sender authoring calls the Send flow makes, over the workspace transport.
// Concurrency (M-A3 §6): every draft write, and send, carries If-Match with the ETag
// of the last response; the server answers 428 without it (native) and 412
// revision_mismatch on a stale one. Idempotency (M-A3 §8): document upload carries one
// Idempotency-Key per document, reused on every retry.
import { ApiError, isApiError } from '../../api/errors';
import type { components, paths } from '../../api/generated/sign';
import type { HttpResponse } from '../../api/http';
import { etagFor, type WorkspaceClient } from '../../api/workspaceClient';
import type { PageSize } from '../editor/geometry';
import { parseEnvelope, type RoutingMode, type ServerEnvelope } from './draftModel';

export interface Versioned {
  readonly env: ServerEnvelope;
  /** The strong validator for the next write. */
  readonly etag: string;
}

export function revisionMismatch(currentRevision: number | null = null): ApiError {
  return new ApiError({
    status: 412,
    code: 'revision_mismatch',
    reason: 'revision_mismatch',
    details: currentRevision !== null ? { current_revision: currentRevision } : {},
  });
}

export function isRevisionMismatch(e: unknown): e is ApiError {
  return isApiError(e) && (e.reason === 'revision_mismatch' || e.status === 412);
}

function versioned(res: HttpResponse<unknown>): Versioned {
  const env = parseEnvelope(res.data);
  const etag =
    res.etag ?? (env.revision !== null ? etagFor({ id: env.id, revision: env.revision }) : null);
  if (!etag) throw new Error('the server returned no envelope version');
  return { env, etag };
}

export interface UploadInput {
  readonly title: string;
  readonly filename: string;
  readonly contentBase64: string;
  readonly idempotencyKey: string;
}

export interface UploadedDocument {
  readonly id: string;
  readonly title: string;
  readonly pages: PageSize[];
}

/**
 * One item of PUT …/fields. M-A6 §2: name_mode on SIGNER_NAME only; label and the
 * group settings on CHECKBOX only. There is deliberately no `value`: a sender never
 * fills a field (the server refuses one, `sender_value_refused`).
 */
export interface FieldWire {
  /** Only on a preserved engine-type field: the stored id it is identical to. */
  readonly id?: string;
  readonly envelope_document_id: string;
  /** null only on a preserved, unassigned engine field. */
  readonly signer_id: string | null;
  /** An authoring type, or an engine type preserved untouched from the server copy. */
  readonly field_type: string;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  /** null only on a preserved engine field stored without a size. */
  readonly width: number | null;
  readonly height: number | null;
  readonly required: boolean;
  readonly name_mode?: 'SIGNER_PROFILE' | 'SIGNER_ENTERED' | string | null;
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly group_rule?: 'SELECT_ONE' | 'SELECT_ANY' | string | null;
  readonly min_selected?: number | null;
}

type SenderFieldsBody =
  paths['/v1/sign/sender/envelopes/{id}/fields']['put']['requestBody']['content']['application/json']['fields'];

export interface SenderApi {
  detail(id: string): Promise<Versioned>;
  create(subject: string): Promise<{ id: string }>;
  update(
    id: string,
    ifMatch: string,
    body: { subject?: string; routing_mode?: RoutingMode; message?: string | null },
  ): Promise<Versioned>;
  upload(id: string, ifMatch: string, input: UploadInput): Promise<UploadedDocument>;
  removeDocument(id: string, ifMatch: string, documentId: string): Promise<Versioned>;
  putRecipients(
    id: string,
    ifMatch: string,
    recipients: readonly {
      id?: string;
      name: string;
      email: string;
      recipient_kind?: components['schemas']['SenderRecipientKind'];
      copy_delivery?: components['schemas']['SenderCopyDelivery'] | null;
    }[],
  ): Promise<Versioned>;
  putFields(id: string, ifMatch: string, fields: readonly FieldWire[]): Promise<Versioned>;
  send(id: string, ifMatch: string, subject: string): Promise<Versioned>;
}

export function createSenderApi(workspace: WorkspaceClient): SenderApi {
  return {
    async detail(id) {
      return versioned(
        await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}', 'get', { path: { id } }),
      );
    },
    async create(subject) {
      const out = await workspace.call('/v1/sign/sender/envelopes', 'post', {
        body: subject ? { subject } : {},
      });
      return { id: out.id };
    },
    async update(id, ifMatch, body) {
      return versioned(
        await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}', 'patch', {
          path: { id },
          body,
          ifMatch,
        }),
      );
    },
    async upload(id, ifMatch, input) {
      const out = await workspace.call('/v1/sign/sender/envelopes/{id}/documents', 'post', {
        path: { id },
        body: { title: input.title, filename: input.filename, content_base64: input.contentBase64 },
        ifMatch,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        id: out.id,
        title: out.title,
        pages: out.pages
          .map((p) => ({ width: p.width ?? 0, height: p.height ?? 0 }))
          .filter((p) => p.width > 0 && p.height > 0),
      };
    },
    async removeDocument(id, ifMatch, documentId) {
      return versioned(
        await workspace.callWithMeta(
          '/v1/sign/sender/envelopes/{id}/documents/{documentId}',
          'delete',
          {
            path: { id, documentId },
            ifMatch,
          },
        ),
      );
    },
    async putRecipients(id, ifMatch, recipients) {
      return versioned(
        await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}/recipients', 'put', {
          path: { id },
          body: { recipients: [...recipients] },
          ifMatch,
        }),
      );
    },
    async putFields(id, ifMatch, fields) {
      return versioned(
        await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}/fields', 'put', {
          path: { id },
          // Preserved engine-type fields keep their server type, which the generated
          // sender enum (the six authoring types) does not list.
          body: { fields: [...fields] as SenderFieldsBody },
          ifMatch,
        }),
      );
    },
    async send(id, ifMatch, subject) {
      return versioned(
        await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}/send', 'post', {
          path: { id },
          body: subject ? { subject } : {},
          ifMatch,
        }),
      );
    },
  };
}
