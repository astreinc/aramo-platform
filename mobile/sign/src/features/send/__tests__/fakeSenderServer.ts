// A fake sign-service sender API for the Send flow tests: enforces If-Match exactly as
// the server does for a native token (428 precondition_required when missing, 412
// revision_mismatch on a stale one; M-A3 §6), bumps the revision once per write, and
// replays a document upload under its Idempotency-Key (M-A3 §8). M-A5: recipient kinds,
// copy timing, Assign to me (bound only for the caller's account email), copy
// recipients excluded from readiness and refused fields, and the self-sign / hosted
// session routes (tokens are fake capability strings).
import { createWorkspaceClient } from '../../../api/workspaceClient';
import { recordingFetch, type RecordedRequest } from '../../../testing/fakes';

const BASE = 'https://sign.aramo.ai';
const ENV_ID = '11111111-2222-4333-8444-555555555555';

export interface FakeEnvelope {
  revision: number;
  status: string;
  subject: string;
  message: string | null;
  routing_mode: 'PARALLEL' | 'SEQUENTIAL';
  allow_delegation: boolean;
  documents: { id: string; title: string }[];
  recipients: {
    id: string;
    name: string;
    email: string | null;
    status: string;
    signing_order: number;
    recipient_kind: string;
    copy_delivery: string | null;
    assigned_to_me: boolean;
    witness_for_signer_id?: string | null;
    access_code_set?: boolean;
    identity_verification_method?: string | null;
  }[];
  fields: Record<string, unknown>[];
}

export function fakeSenderServer(
  opts: {
    dropFirstUploadResponse?: boolean;
    refuseFirstUploads?: number;
    /** The caller's verified account email (Assign to me binds only this one). */
    accountEmail?: string;
  } = {},
) {
  const accountEmail = (opts.accountEmail ?? 'priya@northwind.example').toLowerCase();
  let env: FakeEnvelope | null = null;
  let refusedUploads = 0;
  let seq = 0;
  const uploads = new Map<string, unknown>();
  let dropped = false;
  /** B2 — per-signer messaging choices (PUT …/recipients/{signerId}/messaging). */
  const messaging = new Map<string, Record<string, unknown>>();

  const etag = () => `"${ENV_ID}.${env!.revision}"`;
  const detail = () => ({
    id: ENV_ID,
    subject: env!.subject,
    status: env!.status,
    editable: env!.status === 'DRAFT',
    revision: env!.revision,
    message: env!.message,
    routing_mode: env!.routing_mode,
    allow_delegation: env!.allow_delegation,
    signing_link_valid_days: 7,
    envelope_expires_at: env!.status === 'DRAFT' ? null : '2026-11-24T10:00:00.000Z',
    documents: env!.documents,
    recipients: env!.recipients,
    fields: env!.fields,
  });
  const ok = (body: unknown, status = 200) => ({ status, body, headers: { ETag: etag() } });
  const refuse = (status: number, reason: string, extra: Record<string, unknown> = {}) => ({
    status,
    body: { error: { code: 'INVALID_REQUEST', message: 'refused', details: { reason, ...extra } } },
  });
  const precondition = (r: RecordedRequest) => {
    const m = r.headers['If-Match'];
    if (!m) return refuse(428, 'precondition_required');
    if (m !== etag()) return refuse(412, 'revision_mismatch', { current_revision: env!.revision });
    return null;
  };

  const responder = (r: RecordedRequest) => {
    const path = r.url.replace(BASE, '').split('?')[0]!;
    if (path === '/v1/sign/sender/envelopes' && r.method === 'POST') {
      env = {
        revision: 1,
        status: 'DRAFT',
        subject: String(r.body?.['subject'] ?? ''),
        message: null,
        routing_mode: 'PARALLEL',
        allow_delegation: false,
        documents: [],
        recipients: [],
        fields: [],
      };
      return { status: 201, body: { id: ENV_ID, status: 'DRAFT', subject: env.subject } };
    }
    if (!env || !path.startsWith(`/v1/sign/sender/envelopes/${ENV_ID}`))
      return { status: 404, body: {} };
    const rest = path.slice(`/v1/sign/sender/envelopes/${ENV_ID}`.length);
    if (rest === '' && r.method === 'GET') return ok(detail());
    // M-A5 session routes: no If-Match (they don't change the envelope's revision).
    if (rest === '/self-sign-session' && r.method === 'POST') {
      const id = r.body?.['signer_id'];
      const me = env.recipients.find((x) => x.assigned_to_me && (!id || x.id === id));
      if (!me) return refuse(403, 'not_bound_to_you');
      if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS')
        return refuse(409, 'envelope_not_signable');
      return {
        status: 201,
        body: {
          session_origin: 'SELF',
          signer_id: me.id,
          token: `self-token-${me.id}`,
          expires_at: '2026-10-25T10:30:00.000Z',
        },
      };
    }
    if (rest === '/hosted-sessions' && r.method === 'POST') {
      const s = env.recipients.find((x) => x.id === r.body?.['signer_id']);
      if (!s) return refuse(404, 'signer_not_found');
      if (s.recipient_kind !== 'IN_PERSON_SIGNER') return refuse(409, 'not_in_person_signer');
      return {
        status: 201,
        body: {
          session_origin: 'HOSTED',
          signer_id: s.id,
          token: `hosted-token-${s.id}`,
          expires_at: '2026-10-25T10:30:00.000Z',
        },
      };
    }
    // B2 — messaging routes: no If-Match, and no new revision.
    if (rest === '/messaging' && r.method === 'GET') {
      return {
        status: 200,
        body: {
          envelope_id: ENV_ID,
          features: { sms_delivery: true, whatsapp_delivery: true, sms_otp: true },
          recipients: [...messaging.entries()].map(([signer_id, m]) => ({ signer_id, ...m })),
          deliveries: [],
        },
      };
    }
    const msg = /^\/recipients\/([^/]+)\/messaging$/.exec(rest);
    if (msg && r.method === 'PUT') {
      const id = msg[1]!;
      const s = env.recipients.find((x) => x.id === id);
      if (!s) return refuse(404, 'signer_not_found');
      const channel = (r.body?.['delivery_channel'] as string | null) ?? null;
      const otp = r.body?.['sms_otp_required'] === true;
      if (channel === null && !otp) {
        messaging.delete(id);
        return { status: 200, body: { signer_id: id, delivery_channel: null, sms_otp_required: false } };
      }
      if (s.recipient_kind !== 'SIGNER') return refuse(400, 'recipient_kind_not_supported');
      const phone = r.body?.['phone_e164'];
      if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) return refuse(400, 'invalid_phone');
      const row = { delivery_channel: channel, sms_otp_required: otp, phone_e164: phone };
      messaging.set(id, row);
      return { status: 200, body: { signer_id: id, ...row } };
    }
    const pre = precondition(r);
    if (rest === '/documents' && r.method === 'POST') {
      const key = r.headers['Idempotency-Key'];
      if (key && uploads.has(key)) return { status: 201, body: uploads.get(key) };
      if (pre) return pre;
      if (refusedUploads < (opts.refuseFirstUploads ?? 0)) {
        refusedUploads += 1;
        return refuse(503, 'service_unavailable');
      }
      const doc = {
        id: `doc-${++seq}`,
        title: String(r.body?.['title']),
        page_count: 1,
        pages: [{ width: 612, height: 792 }],
      };
      env.documents.push({ id: doc.id, title: doc.title });
      env.revision += 1;
      if (key) uploads.set(key, doc);
      if (opts.dropFirstUploadResponse && !dropped) {
        dropped = true;
        throw new Error('connection reset');
      }
      return { status: 201, body: doc };
    }
    if (pre) return pre;
    if (rest === '' && r.method === 'PATCH') {
      if (typeof r.body?.['subject'] === 'string') env.subject = r.body['subject'] as string;
      if (r.body?.['routing_mode'])
        env.routing_mode = r.body['routing_mode'] as FakeEnvelope['routing_mode'];
      if ('message' in (r.body ?? {})) env.message = (r.body?.['message'] as string | null) ?? null;
      if (typeof r.body?.['allow_delegation'] === 'boolean')
        env.allow_delegation = r.body['allow_delegation'] as boolean;
      env.revision += 1;
      return ok(detail());
    }
    if (rest.startsWith('/documents/') && r.method === 'DELETE') {
      const id = rest.slice('/documents/'.length);
      env.documents = env.documents.filter((d) => d.id !== id);
      env.fields = env.fields.filter((f) => f['envelope_document_id'] !== id);
      env.revision += 1;
      return ok(detail());
    }
    if (rest === '/recipients' && r.method === 'PUT') {
      const list = r.body?.['recipients'] as {
        id?: string;
        name: string;
        email?: string | null;
        recipient_kind?: string;
        copy_delivery?: string | null;
        assign_to_me?: boolean;
        witness_for_index?: number | null;
        access_code?: string | null;
        identity_verification_method?: string | null;
      }[];
      for (const x of list) {
        const kind = x.recipient_kind ?? 'SIGNER';
        if (kind === 'RECEIVES_COPY' && !x.copy_delivery)
          return refuse(400, 'copy_delivery_required');
        if (kind !== 'RECEIVES_COPY' && x.copy_delivery)
          return refuse(400, 'copy_delivery_not_allowed');
        if (!x.email && kind !== 'IN_PERSON_SIGNER') return refuse(400, 'invalid_request');
        if (x.assign_to_me && kind !== 'SIGNER') return refuse(400, 'assign_to_me_not_signer');
        if (x.assign_to_me && (x.email ?? '').toLowerCase() !== accountEmail)
          return refuse(403, 'assign_to_me_email_mismatch');
        if (kind === 'WITNESS' && typeof x.witness_for_index !== 'number')
          return refuse(400, 'witness_for_required');
      }
      const ids = list.map((x) => x.id ?? `sig-${++seq}`);
      const before = new Map(env.recipients.map((x) => [x.id, x]));
      env.recipients = list.map((x, i) => ({
        id: ids[i]!,
        witness_for_signer_id:
          typeof x.witness_for_index === 'number' ? (ids[x.witness_for_index] ?? null) : null,
        // Omitted keeps the stored code; null clears it.
        access_code_set:
          x.access_code === undefined ? before.get(ids[i]!)?.access_code_set === true : x.access_code !== null,
        identity_verification_method:
          x.identity_verification_method === undefined
            ? (before.get(ids[i]!)?.identity_verification_method ?? null)
            : x.identity_verification_method,
        name: x.name,
        email: x.email ?? null,
        status: 'PENDING',
        signing_order: i,
        recipient_kind: x.recipient_kind ?? 'SIGNER',
        copy_delivery: x.copy_delivery ?? null,
        assigned_to_me: x.assign_to_me === true,
      }));
      env.fields = env.fields.filter((f) => env!.recipients.some((x) => x.id === f['signer_id']));
      env.revision += 1;
      return ok(detail());
    }
    if (rest === '/fields' && r.method === 'PUT') {
      const fields = r.body?.['fields'] as Record<string, unknown>[];
      const copies = new Set(
        env.recipients.filter((x) => x.recipient_kind === 'RECEIVES_COPY').map((x) => x.id),
      );
      if (fields.some((f) => copies.has(f['signer_id'] as string)))
        return refuse(400, 'copy_recipient_has_fields');
      env.fields = fields;
      env.revision += 1;
      return ok(detail());
    }
    if (rest === '/send' && r.method === 'POST') {
      const signers = new Set(
        env.fields.filter((f) => f['field_type'] === 'SIGNATURE').map((f) => f['signer_id']),
      );
      const signing = env.recipients.filter((x) => x.recipient_kind !== 'RECEIVES_COPY');
      if (
        env.documents.length === 0 ||
        signing.length === 0 ||
        signing.some((x) => !signers.has(x.id))
      )
        return refuse(400, 'not_ready');
      env.status = 'SENT';
      env.revision += 1;
      return ok(detail());
    }
    return { status: 404, body: {} };
  };

  const http = recordingFetch(responder);
  const workspace = createWorkspaceClient({
    baseUrl: BASE,
    fetch: http.fetch,
    session: {
      getAccessToken: async () => 'access-token',
      refreshAccessToken: async () => 'access-token',
      sessionExpired: () => undefined,
    },
  });
  return {
    workspace,
    calls: http.calls,
    get envelope() {
      return env;
    },
    messaging,
    /** Someone else (the web editor) changes the draft. */
    editElsewhere(fn: (e: FakeEnvelope) => void) {
      fn(env!);
      env!.revision += 1;
    },
    ENV_ID,
  };
}
