// The sender authoring calls the Send flow makes, over the workspace transport.
// Concurrency (M-A3 §6): every draft write, and send, carries If-Match with the ETag
// of the last response; the server answers 428 without it (native) and 412
// revision_mismatch on a stale one. Idempotency (M-A3 §8): document upload carries one
// Idempotency-Key per document, reused on every retry.
import { ApiError, isApiError } from '../../api/errors';
import type { paths } from '../../api/generated/sign';
import type { HttpResponse } from '../../api/http';
import { etagFor, type WorkspaceClient } from '../../api/workspaceClient';
import type { PageSize } from '../editor/geometry';
import {
  parseEnvelope,
  type MessagingBySigner,
  type RecipientMessaging,
  type RoutingMode,
  type ServerEnvelope,
  type TextChannel,
} from './draftModel';
import type { RecipientWire } from './recipientRoles';

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
    body: {
      subject?: string;
      routing_mode?: RoutingMode;
      message?: string | null;
      allow_delegation?: boolean;
    },
  ): Promise<Versioned>;
  upload(id: string, ifMatch: string, input: UploadInput): Promise<UploadedDocument>;
  removeDocument(id: string, ifMatch: string, documentId: string): Promise<Versioned>;
  putRecipients(
    id: string,
    ifMatch: string,
    recipients: readonly RecipientWire[],
  ): Promise<Versioned>;
  putFields(id: string, ifMatch: string, fields: readonly FieldWire[]): Promise<Versioned>;
  /**
   * Feature-Parity §1.7–§1.9 — one signer's text delivery and SMS code. Its own route:
   * no If-Match, and the envelope's revision does not change. Channel null with the code
   * off clears the choice.
   */
  putMessaging(id: string, signerId: string, body: MessagingWire): Promise<void>;
  /** The envelope's messaging choices by signer id (refused while no messaging feature is available). */
  messaging(id: string): Promise<MessagingBySigner>;
  send(id: string, ifMatch: string, subject: string): Promise<Versioned>;
  /**
   * M-A5 §4.2 "Sign a document": a SELF session for the recipient assigned to the
   * caller. The token is a signing capability: the caller stashes it in the in-memory
   * vault at once (links/guestTokenVault.ts) and never logs, stores or routes it.
   */
  selfSignSession(id: string, signerId?: string): Promise<IssuedSigningSession>;
  /** M-A5 §3.2: a HOSTED session for an in-person signer whose turn it is. Same token rules. */
  hostedSession(id: string, signerId: string): Promise<IssuedSigningSession>;
}

export interface MessagingWire {
  readonly delivery_channel: TextChannel | null;
  readonly sms_otp_required: boolean;
  readonly phone_e164?: string;
}

/** The PUT …/messaging body for a recipient's choice (a cleared choice sends no phone). */
export function messagingToWire(m: RecipientMessaging): MessagingWire {
  const set = m.channel !== null || m.smsOtp;
  return {
    delivery_channel: m.channel,
    sms_otp_required: m.smsOtp,
    ...(set ? { phone_e164: m.phone.trim() } : {}),
  };
}

export interface IssuedSigningSession {
  readonly token: string;
  readonly signerId: string;
  readonly expiresAt: string;
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
    async putMessaging(id, signerId, body) {
      await workspace.call('/v1/sign/sender/envelopes/{id}/recipients/{signerId}/messaging', 'put', {
        path: { id, signerId },
        body: { ...body },
      });
    },
    async messaging(id) {
      const out = await workspace.call('/v1/sign/sender/envelopes/{id}/messaging', 'get', {
        path: { id },
      });
      const map = new Map<string, RecipientMessaging>();
      for (const r of out.recipients ?? []) {
        if (!r.signer_id) continue;
        map.set(r.signer_id, {
          channel: r.delivery_channel === 'SMS' || r.delivery_channel === 'WHATSAPP' ? r.delivery_channel : null,
          smsOtp: r.sms_otp_required === true,
          phone: r.phone_e164 ?? '',
        });
      }
      return map;
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
    async selfSignSession(id, signerId) {
      const out = await workspace.call('/v1/sign/sender/envelopes/{id}/self-sign-session', 'post', {
        path: { id },
        body: signerId ? { signer_id: signerId } : {},
      });
      return { token: out.token, signerId: out.signer_id, expiresAt: out.expires_at };
    },
    async hostedSession(id, signerId) {
      const out = await workspace.call('/v1/sign/sender/envelopes/{id}/hosted-sessions', 'post', {
        path: { id },
        body: { signer_id: signerId },
      });
      return { token: out.token, signerId: out.signer_id, expiresAt: out.expires_at };
    },
  };
}
