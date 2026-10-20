import { ApiError, apiClient, getAuthConsumer } from '@aramo/fe-foundation';

// PX-1 — typed client for the authenticated sender surface (/v1/sign/sender/*).
// Every call carries the `sign` session cookie (credentials: include) and the
// X-Aramo-Consumer header via the shared fe-foundation ApiClient, which also
// performs the single-flight silent refresh. The backend is the only authority
// for tenant, workspace and permissions; this module never decides access.
//
// Field geometry on the wire is PDF-native: page_number 0-based, points, origin
// bottom-left, (x, y) the box's lower-left corner — see pdf-geometry.ts for the
// conversion to the editor's top-left canvas frame.

const BASE = '/v1/sign/sender';

export type EnvelopeStatus = 'DRAFT' | 'SENT' | 'IN_PROGRESS' | 'COMPLETED' | 'DECLINED' | 'VOIDED' | 'EXPIRED';
export type RecipientStatus = 'PENDING' | 'VIEWED' | 'SIGNED' | 'DECLINED';
export type FieldType = 'SIGNATURE' | 'INITIALS' | 'SIGN_DATE' | 'SIGNER_NAME' | 'TEXT' | 'CHECKBOX' | 'ACKNOWLEDGEMENT';

export interface SenderContext {
  user: { id: string; email: string | null; display_name: string | null };
  tenant: { id: string; name: string; kind: string };
  workspace: 'sign' | 'personal';
  // Sign Unified Product S-1 — the caller's effective Sign permissions. The newer
  // keys are optional so an older backend still renders (absent = not permitted).
  permissions: {
    read: boolean;
    create: boolean;
    send: boolean;
    read_all?: boolean;
    manage_all?: boolean;
    contacts?: boolean;
    members?: boolean;
    billing?: boolean;
  };
  can_send: boolean;
  personal_sending_enabled: false;
  organization_url: string | null;
  app_home_url: string | null;
}

export interface Summary {
  counts: Record<'draft' | 'sent' | 'in_progress' | 'completed' | 'declined' | 'voided' | 'expired', number>;
  awaiting_signatures: number;
  completed_this_month: number;
  declined_or_expired: number;
  months: { month: string; sent: number; completed: number; declined_or_expired: number }[];
  completion_rate: number | null;
  expiring_soon: { id: string; subject: string; expires_at: string }[];
  signing_window_days: number;
}

export interface EnvelopeRow {
  id: string;
  subject: string;
  status: EnvelopeStatus;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  document_count: number;
  recipients: { id: string; name: string; email: string; status: RecipientStatus }[];
  // Sign Unified Product S-3 — 'aramo-sign' or the application that sent it (e.g. 'aramo-ats').
  source_application?: string;
}

// A short label for an envelope sent by another Aramo application, or null for Sign's own.
export function sourceLabel(source: string | undefined): string | null {
  if (source === undefined || source === 'aramo-sign') return null;
  if (source === 'aramo-ats') return 'From Aramo ATS';
  return 'From an integration';
}

export interface EnvelopeList {
  items: EnvelopeRow[];
  counts: Partial<Record<EnvelopeStatus, number>>;
}

export interface EnvelopeDocument {
  id: string;
  title: string;
  ordinal: number;
  content_type: string | null;
  byte_size: number | null;
  source_sha256: string;
  field_count: number;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
  status: RecipientStatus;
  signing_order: number;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  // Multi-Signer — an unsigned signer who may sign now (any order, or their turn).
  can_remind?: boolean;
}

export interface EnvelopeField {
  id?: string;
  envelope_document_id: string;
  signer_id: string;
  field_type: FieldType;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  filled?: boolean;
}

export type RoutingMode = 'PARALLEL' | 'SEQUENTIAL';
// Aramo-Sign-Multi-Signer-Amendment — at most this many signers per envelope.
export const MAX_SIGNERS = 10;

export interface EnvelopeDetail {
  id: string;
  // Sign Unified Product S-3 — envelopes from another application are read-only here.
  source_application?: string;
  subject: string;
  status: EnvelopeStatus;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  voided_at: string | null;
  expires_at: string | null;
  signing_window_days: number;
  sender: { id: string; name: string | null };
  editable: boolean;
  // Multi-Signer §4 — Sign in any order (PARALLEL) or Sign in order (SEQUENTIAL), and who may sign now.
  routing_mode?: RoutingMode;
  next_signer_id?: string | null;
  documents: EnvelopeDocument[];
  recipients: Recipient[];
  fields: EnvelopeField[];
}

export interface LedgerEvent {
  id: string;
  envelope_id?: string;
  envelope_subject?: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  actor_type: string;
  detail: Record<string, string> | null;
  event_hash: string;
}

export interface UploadedDocument {
  id: string;
  title: string;
  ordinal: number;
  byte_size: number | null;
  page_count: number;
  pages: { width: number; height: number }[];
}

export interface DocumentRow {
  id: string;
  title: string;
  content_type: string | null;
  byte_size: number | null;
  source: 'UPLOAD' | 'ARAMO_DOCUMENT';
  uploaded_at: string;
  envelope: { id: string; subject: string; status: EnvelopeStatus };
  owner: string | null;
}

export interface ContactRow {
  name: string;
  email: string;
  envelope_count: number;
  last_used_at: string;
}

export interface ExecutedBundle {
  envelope_id: string;
  documents: { envelope_document_id: string; title: string; executed_sha256: string; byte_size: number; executed_base64: string }[];
  certificate: { certificate_sha256: string; byte_size: number; certificate_base64: string } | null;
}

export interface Evidence {
  envelope_id: string;
  status: string;
  event_chain_hash: string;
  signature: string;
  signature_algorithm: string;
  completed_at: string | null;
}

const enc = encodeURIComponent;

// Aramo Sign launch — self-service billing (/v1/sign/billing/*). The backend is
// the only authority for the plan, status and usage; the console only renders
// them and hands the browser to the provider-hosted checkout / portal pages.
const BILLING = '/v1/sign/billing';

export interface Money {
  amount_minor: number;
  currency: string;
  interval?: string | null;
}

// Commercial Plans Amendment A1 — a catalog plan as the backend reports it.
export interface BillingPlan {
  key: string;
  name: string;
  description: string | null;
  tenant_kind: string | null;
  sales_model: 'SELF_SERVICE' | 'FREE' | 'CONTACT_SALES' | 'OPERATOR';
  status: 'ACTIVE' | 'INACTIVE';
  price: Money | null;
  // Present only when the comparison price is substantiated.
  reference_price: Money | null;
  commitment_months: number | null;
  eligibility: string | null;
  eligible: boolean;
  support_tier: string | null;
  activation_note: string | null;
  // `available` — the capability is built and operational. Anything not
  // available is never advertised (A1 review: entitlement ≠ launch availability).
  allowances: { allowance_key: string; included_quantity: number | null; unlimited: boolean; period: string; available?: boolean }[];
  capacities: { capacity_key: string; limit: number | null; unlimited: boolean; available?: boolean }[];
  features: { feature_key: string; enabled: boolean; available?: boolean }[];
  purchasable: boolean;
}

export interface BillingCatalog {
  plans: BillingPlan[];
  terms: { version: string; url: string } | null;
  sales_contact_url: string | null;
}

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE';

export interface BillingAccount {
  subscription: {
    plan_key: string;
    plan_name: string;
    source: 'MANUAL' | 'DEVELOPMENT' | 'SELF_SERVICE';
    status: SubscriptionStatus;
    sending: boolean;
    started_at: string;
    ended_at: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    grace_until: string | null;
    billing_managed: boolean;
    commitment_months?: number | null;
    commitment_end?: string | null;
    cancel_requested_within_commitment?: boolean;
    eligibility_state?: 'OK' | 'LAPSED' | null;
    list_price?: Money | null;
    features?: { feature_key: string; enabled: boolean }[];
    export_access_until?: string | null;
  } | null;
  allowance:
    | { subscribed: true; plan_key: string; allowance_key: string; limit: number | null; unlimited?: boolean; used: number; remaining: number | null; period_start: string; period_end: string; threshold: 'OK' | 'WARNING' | 'EXHAUSTED' }
    | { subscribed: false; allowance_key: string; state?: 'NONE' | 'PAST_DUE' | 'INCOMPLETE' | 'CANCELED' };
  storage?: { capacity_key: string; limit: number | null; unlimited: boolean; used: number } | null;
  billing_available: boolean;
  tenant_kind: string;
  self_service_eligible: boolean;
  can_manage_billing: boolean;
}

export const billingApi = {
  plans: () => apiClient.get<BillingCatalog>(`${BILLING}/plans`),
  account: () => apiClient.get<BillingAccount>(`${BILLING}/account`),
  checkout: (plan_key: string, accept_terms?: boolean) =>
    apiClient.post<{ url: string }>(`${BILLING}/checkout`, accept_terms === undefined ? { plan_key } : { plan_key, accept_terms }),
  portal: () => apiClient.post<{ url: string }>(`${BILLING}/portal`, {}),
};

export type SignRoleKey = 'sign_owner' | 'sign_admin' | 'sign_sender' | 'sign_viewer';

export interface SignMember {
  user_id: string;
  email: string;
  display_name: string | null;
  active: boolean;
  sign_role: SignRoleKey | null;
  sign_role_display: string | null;
}

export const senderApi = {
  context: () => apiClient.get<SenderContext>(`${BASE}/context`),
  summary: () => apiClient.get<Summary>(`${BASE}/summary`),
  list: (q: { tab?: string; q?: string; days?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.tab !== undefined && q.tab !== 'all') p.set('tab', q.tab);
    if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
    if (q.days !== undefined) p.set('days', String(q.days));
    const qs = p.toString();
    return apiClient.get<EnvelopeList>(`${BASE}/envelopes${qs === '' ? '' : `?${qs}`}`);
  },
  create: (subject?: string) => apiClient.post<{ id: string; status: EnvelopeStatus; subject: string }>(`${BASE}/envelopes`, subject !== undefined ? { subject } : {}),
  detail: (id: string) => apiClient.get<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`),
  rename: (id: string, subject: string) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { subject }),
  setRouting: (id: string, routing_mode: RoutingMode) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { routing_mode }),
  events: (id: string) => apiClient.get<{ items: LedgerEvent[] }>(`${BASE}/envelopes/${enc(id)}/events`),
  upload: (id: string, file: { filename: string; title: string; content_base64: string }) =>
    apiClient.post<UploadedDocument>(`${BASE}/envelopes/${enc(id)}/documents`, file),
  renameDocument: (id: string, docId: string, title: string) =>
    apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/${enc(docId)}`, { title }),
  reorderDocuments: (id: string, order: string[]) => apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/order`, { order }),
  removeDocument: (id: string, docId: string) => apiClient.delete<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/${enc(docId)}`),
  recipients: (id: string, recipients: { id?: string; name: string; email: string }[]) =>
    apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/recipients`, { recipients }),
  fields: (id: string, fields: EnvelopeField[]) =>
    apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/fields`, {
      fields: fields.map(({ envelope_document_id, signer_id, field_type, page_number, x, y, width, height, required }) => ({
        envelope_document_id, signer_id, field_type, page_number, x, y, width, height, required,
      })),
    }),
  send: (id: string, subject?: string) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/send`, subject !== undefined ? { subject } : {}),
  // signer_id — remind one signer; omitted, everyone who may sign now.
  remind: (id: string, signer_id?: string) =>
    apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/remind`, signer_id !== undefined ? { signer_id } : {}),
  void: (id: string, reason: string) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/void`, { reason }),
  executed: (id: string) => apiClient.get<ExecutedBundle>(`${BASE}/envelopes/${enc(id)}/executed`),
  evidence: (id: string) => apiClient.get<Evidence>(`${BASE}/envelopes/${enc(id)}/evidence`),
  documents: () => apiClient.get<{ items: DocumentRow[] }>(`${BASE}/documents`),
  contacts: () => apiClient.get<{ items: ContactRow[] }>(`${BASE}/contacts`),
  members: () => apiClient.get<{ items: SignMember[]; roles: { key: SignRoleKey; display: string }[] }>(`${BASE}/members`),
  setMemberRole: (userId: string, sign_role: SignRoleKey | null) =>
    apiClient.put<SignMember>(`${BASE}/members/${encodeURIComponent(userId)}/sign-role`, { sign_role }),
  activity: (limit = 200) => apiClient.get<{ items: LedgerEvent[] }>(`${BASE}/activity?limit=${limit}`),
};

// PDF bytes for the editor / preview. Binary, so it bypasses the JSON client but
// keeps the same credentials + consumer header and the same one-shot refresh on 401.
export async function fetchSourcePdf(envelopeId: string, documentId: string): Promise<ArrayBuffer> {
  const url = `${BASE}/envelopes/${enc(envelopeId)}/documents/${enc(documentId)}/source`;
  const get = () => fetch(url, { credentials: 'include', headers: { 'X-Aramo-Consumer': getAuthConsumer() } });
  let res = await get();
  if (res.status === 401) {
    const refreshed = await fetch(`/auth/${getAuthConsumer()}/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) res = await get();
  }
  if (!res.ok) throw new ApiError(res.status, `Could not load the document (${res.status})`);
  return res.arrayBuffer();
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function errorMessage(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (e instanceof ApiError) {
    // Plan / allowance refusals (Aramo Sign subscription gate) — never shown as a
    // permission problem.
    if (e.code === 'ESIGN_NOT_SUBSCRIBED') return 'Your organization doesn’t have an active Aramo Sign plan, so envelopes can’t be sent. An admin can choose a plan in Settings → Plan & billing.';
    if (e.code === 'ESIGN_ALLOWANCE_EXHAUSTED') {
      const limit = e.details?.['limit'];
      const end = typeof e.details?.['period_end'] === 'string' ? new Date(String(e.details['period_end'])).toLocaleDateString() : null;
      return `You’ve used all ${typeof limit === 'number' ? `${limit} ` : ''}envelopes in this billing period${end ? `; it renews on ${end}` : ''}. An admin can manage the plan in Settings → Plan & billing.`;
    }
    if (e.code === 'ESIGN_BILLING_UNAVAILABLE') return 'Online billing isn’t available right now. Try again later, or contact Aramo support.';
    if (e.code === 'ESIGN_BILLING_CONFLICT' && e.details?.['reason'] === 'ALREADY_SUBSCRIBED') return 'Your organization already has a subscription. Use Manage billing to change it.';
    if (e.code === 'ESIGN_BILLING_CONFLICT' && e.details?.['reason'] === 'PLAN_NOT_ELIGIBLE') return 'Standard Professional is for organizations with an Aramo ATS subscription.';
    if (e.code === 'ESIGN_BILLING_CONFLICT') return 'Your organization doesn’t have a billing account yet. Choose a plan first.';
    if (e.code === 'ESIGN_STORAGE_QUOTA_EXCEEDED') return 'Your organization’s storage is full. Remove draft documents you no longer need, or an admin can change the plan in Settings → Plan & billing.';
    if (e.status === 403 && e.details?.['reason'] === 'personal_sending_not_enabled') return 'Sending from a personal account isn’t enabled yet.';
    if (e.status === 403) return 'You don’t have permission to do that.';
    if (e.code === 'ENVELOPE_ILLEGAL_TRANSITION') return 'This envelope can’t be changed in its current state.';
    return e.message.length > 0 ? e.message : fallback;
  }
  return fallback;
}

// Sign Unified Product S-7 — the recipient inbox (/v1/sign/inbox). A recipient
// right: available to any signed-in Aramo Sign user, limited to their own
// recipient bindings.
export interface InboxItem {
  id: string;
  subject: string;
  from: string | null;
  envelope_status: EnvelopeStatus;
  my_status: RecipientStatus;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  signed_at: string | null;
  can_sign: boolean;
  can_download: boolean;
}

export const inboxApi = {
  list: () => apiClient.get<{ waiting: InboxItem[]; completed: InboxItem[]; other: InboxItem[] }>('/v1/sign/inbox'),
  claim: (token: string) => apiClient.post<{ id: string }>('/v1/sign/inbox/claim', { token }),
  sign: (id: string) => apiClient.post<{ signing_url: string }>(`/v1/sign/inbox/${encodeURIComponent(id)}/sign`),
  signedCopy: (id: string) => apiClient.post<{ download_url: string }>(`/v1/sign/inbox/${encodeURIComponent(id)}/signed-copy`),
  remove: (id: string) => apiClient.delete<{ removed: boolean }>(`/v1/sign/inbox/${encodeURIComponent(id)}`),
};

// The capability token from a pasted signing link (…/s/<token>) or a bare token.
export function tokenFromSigningLink(input: string): string | null {
  const v = input.trim();
  const m = /\/s\/([A-Za-z0-9_-]{20,})/.exec(v);
  if (m !== null && m[1] !== undefined) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null;
}
