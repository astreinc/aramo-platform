// A fake sign-service sender API for the Send flow tests: enforces If-Match exactly as
// the server does for a native token (428 precondition_required when missing, 412
// revision_mismatch on a stale one; M-A3 §6), bumps the revision once per write, and
// replays a document upload under its Idempotency-Key (M-A3 §8).
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
  documents: { id: string; title: string }[];
  recipients: { id: string; name: string; email: string; status: string; signing_order: number }[];
  fields: Record<string, unknown>[];
}

export function fakeSenderServer(opts: { dropFirstUploadResponse?: boolean } = {}) {
  let env: FakeEnvelope | null = null;
  let seq = 0;
  const uploads = new Map<string, unknown>();
  let dropped = false;

  const etag = () => `"${ENV_ID}.${env!.revision}"`;
  const detail = () => ({
    id: ENV_ID,
    subject: env!.subject,
    status: env!.status,
    editable: env!.status === 'DRAFT',
    revision: env!.revision,
    message: env!.message,
    routing_mode: env!.routing_mode,
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
    const pre = precondition(r);
    if (rest === '/documents' && r.method === 'POST') {
      const key = r.headers['Idempotency-Key'];
      if (key && uploads.has(key)) return { status: 201, body: uploads.get(key) };
      if (pre) return pre;
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
      const list = r.body?.['recipients'] as { id?: string; name: string; email: string }[];
      env.recipients = list.map((x, i) => ({
        id: x.id ?? `sig-${++seq}`,
        name: x.name,
        email: x.email,
        status: 'PENDING',
        signing_order: i,
      }));
      env.fields = env.fields.filter((f) => env!.recipients.some((x) => x.id === f['signer_id']));
      env.revision += 1;
      return ok(detail());
    }
    if (rest === '/fields' && r.method === 'PUT') {
      env.fields = r.body?.['fields'] as Record<string, unknown>[];
      env.revision += 1;
      return ok(detail());
    }
    if (rest === '/send' && r.method === 'POST') {
      const signers = new Set(
        env.fields.filter((f) => f['field_type'] === 'SIGNATURE').map((f) => f['signer_id']),
      );
      if (env.documents.length === 0 || env.recipients.some((x) => !signers.has(x.id)))
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
    /** Someone else (the web editor) changes the draft. */
    editElsewhere(fn: (e: FakeEnvelope) => void) {
      fn(env!);
      env!.revision += 1;
    },
    ENV_ID,
  };
}
