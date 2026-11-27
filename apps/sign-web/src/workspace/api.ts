import { ApiError, apiClient, getAuthConsumer } from '@aramo/fe-foundation';
import {
  E164_PATTERN,
  ENVELOPE_SUBJECT_MAX,
  SEAT_LIMIT_REASON,
  isValidAccessCode,
  placeableFieldTypes,
  refusalMessage,
  isReminderStale as sharedReminderStale,
  type AnyFieldType,
  type FieldTypeOn,
  type InboxActions,
  type SenderActions,
  type AutoRemindersView,
} from '@aramo/sign-client';

// Client Rule Consolidation C3 — the limits, patterns, status sets and refusal copy live once
// in @aramo/sign-client (the server and the Aramo Sign app use the same copy).
export {
  ENVELOPE_CHANGED,
  ENVELOPE_MESSAGE_MAX,
  ENVELOPE_NOT_AVAILABLE,
  ENVELOPE_SUBJECT_MAX,
  INBOX_ITEM_CHANGED,
  MAX_COPY_RECIPIENTS,
  MAX_SIGNERS,
  SEAT_LIMIT_REASON,
  SIGN_DATE_FORMATS,
  seatLimitMessage,
} from '@aramo/sign-client';

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
// Sign 1.14 — PAYMENT: paid by the signer on Stripe's hosted page (only while features.payments).
// M-A12 W1-C.4 — + the profile text fields FIRST_NAME, LAST_NAME, EMAIL, COMPANY, TITLE.
// FIELD-PARITY-1 P1-2 — every type an envelope stores: the catalog's `sign_store` projection.
export type FieldType = AnyFieldType;

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
    // DOC-TEMPLATE-LIB-1 T-5 — document_template:read (start envelopes from templates).
    templates?: boolean;
    // Feature-Parity §1.13 — sign:report:read (organization reports).
    reports?: boolean;
  };
  // DOC-TEMPLATE-LIB-1 T-5 — plan capabilities by launch availability (absent = not available).
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §3.7 — in_person_signing (hosted signing; mobile only this release).
  // Sign 1.14 — payments (Stripe Connect): available to this organization.
  // Feature-Parity §1.13 — reports = the sign.reports capability (BUSINESS only; absent = not available).
  // Consolidated Directive v1.0 B2 — the sender's per-recipient choices (absent = not available):
  // witness and delegate signing, the access code, SMS / WhatsApp delivery, the SMS code, and
  // the identity checks (government ID; KBA).
  features?: {
    templates?: boolean;
    in_person_signing?: boolean;
    payments?: boolean;
    reports?: boolean;
    witness_signing?: boolean;
    delegate_signing?: boolean;
    access_code?: boolean;
    sms_delivery?: boolean;
    whatsapp_delivery?: boolean;
    sms_otp?: boolean;
    id_verification?: boolean;
    kba?: boolean;
  };
  can_send: boolean;
  // Aramo Sign Personal (Free) — true only while Personal sending is switched on for this
  // deployment; whether THIS account may send is still `can_send` (backend-decided).
  personal_sending_enabled: boolean;
  organization_url: string | null;
  app_home_url: string | null;
  // ORG-UX-1 (LOCKED §4.3/§6) — role-based (tenant_owner / tenant_admin); absent = false.
  org_admin?: boolean;
  // ORG-UX-1 §6 — Organization → Users & product access (the single role surface).
  organization_roles_url?: string | null;
  // Aramo-Sign-Mobile-Amendment-M-A8 §2.1 — true only for the tenant_owner of a PERSONAL
  // tenant (may delete their own account); absent on an older backend.
  personal_account_owner?: boolean;
  // TEMPLATE-PRODUCT-1 §8.1 — the plan side of templates (Catalog v2 P-6: FREE_PLAN gets an
  // upgrade prompt, never templates); null / absent when not read (templates not available).
  template_plan?: 'INCLUDED' | 'FREE_PLAN' | 'SUBSCRIPTION_INACTIVE' | 'NOT_SUBSCRIBED' | null;
  // TEMPLATE-PRODUCT-1 §8.2 — a PERSONAL account's own template Studio in Aramo Sign.
  template_studio?: boolean;
  // TEMPLATE-PRODUCT-1 §8.5 — "Use as it is" (the person may approve templates).
  template_use_as_is?: boolean;
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

// Retention and Purge directive (DocuSign parity) — what a purge removes, and an envelope's purge state.
export type PurgeLevel = 'DOCUMENTS' | 'DOCUMENTS_AND_METADATA' | 'DOCUMENTS_AND_METADATA_AND_REDACT';
export const PURGE_LEVELS: { key: PurgeLevel; label: string; help: string }[] = [
  { key: 'DOCUMENTS', label: 'Documents', help: 'Signed documents and the certificate PDF are deleted. Envelope details and history stay.' },
  { key: 'DOCUMENTS_AND_METADATA', label: 'Documents and details', help: 'Also clears the subject, message, document names and entered field values.' },
  { key: 'DOCUMENTS_AND_METADATA_AND_REDACT', label: 'Documents, details and personal data', help: 'Also removes recipient names, email addresses and IP addresses from the envelope and its history.' },
];
export function purgeLevelLabel(level: PurgeLevel | null | undefined): string {
  return PURGE_LEVELS.find((l) => l.key === level)?.label ?? 'Documents';
}
export interface PurgeInfo {
  state: 'QUEUED' | 'DEQUEUED' | 'EXECUTED';
  level: PurgeLevel;
  due_at: string | null;
  executed_at: string | null;
}
export interface RetentionPolicy {
  // null = keep forever (the default).
  retention_days: number | null;
  purge_level: PurgeLevel;
  updated_at: string | null;
  can_edit: boolean;
}
export const RETENTION_MAX_DAYS = 9999;

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
  // Retention and Purge — absent from an older server (read as no purge).
  purge?: PurgeInfo | null;
  // W2 (A3.5) — true when the only step anyone can take now is the signed-in sender's own
  // signature (the server decides; absent from an older server = false).
  awaiting_you?: boolean;
  // W2 — the signed-in sender's own inbox item for that step (a binding id or a discovered
  // item handle) when awaiting_you; null when there is none.
  my_inbox_item_id?: string | null;
  // Client Rule Consolidation C1 — what the caller may do (the server decides; read it with
  // senderActionsOf, which treats an absent object as nothing allowed).
  actions?: SenderActions;
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

// Aramo-Sign-Unified-Product-Amendment-M-A5 §1 / §2 — recipient kinds and copy timing.
// Feature-Parity §1.17 — WITNESS attests for one signer (witness_for_signer_id).
export type RecipientKind = 'SIGNER' | 'IN_PERSON_SIGNER' | 'RECEIVES_COPY' | 'WITNESS';
// Feature-Parity §1.9 — the identity check the sender may require of a recipient.
export type IdentityVerificationMethod = 'ID_VERIFICATION' | 'KBA';
// Feature-Parity §1.7 / §1.8 — the signing link also goes to the phone (email is always sent).
export type DeliveryChannel = 'SMS' | 'WHATSAPP';
export type CopyDelivery = 'ON_SEND' | 'ON_COMPLETION' | 'BOTH';
// M-A5 §1.4 — at most this many copy recipients per envelope (besides MAX_SIGNERS signers).
export interface Recipient {
  id: string;
  name: string;
  // M-A5 §3.5 — null only for an in-person signer without an email (added from the app).
  email: string | null;
  status: RecipientStatus;
  signing_order: number;
  // M-A5 — absent from an older server: read as SIGNER.
  recipient_kind?: RecipientKind;
  copy_delivery?: CopyDelivery | null;
  // M-A5 §4.1 — this recipient is assigned to the signed-in user (Assign to me).
  assigned_to_me?: boolean;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  // Multi-Signer — an unsigned signer who may sign now (any order, or their turn).
  can_remind?: boolean;
  // UAT SND-14 — when this signer can be reminded again (ISO), while a reminder is cooling down.
  reminder_available_at?: string | null;
  // Client Rule Consolidation C3 — the caller may host this in-person signer now (detail only).
  hostable?: boolean;
  // Amendment M-A6 §3.5 — the template role this recipient was bound to; null otherwise.
  role_key?: string | null;
  // Feature-Parity §1.17 — the recipient a WITNESS attests for (null otherwise).
  witness_for_signer_id?: string | null;
  // §1.9 — an access code is set / the recipient is locked out (the code is never returned).
  access_code_set?: boolean;
  access_code_locked?: boolean;
  // §1.9 — the identity check required of this recipient (null = none).
  identity_verification_method?: IdentityVerificationMethod | null;
  // §1.17 — the original recipient of a delegated slot.
  delegated_from?: { name: string | null; email: string | null; delegated_at: string } | null;
}

// Feature-Parity §1.7–§1.9 — one recipient's text-message choices (GET …/messaging).
export interface RecipientMessaging {
  signer_id: string;
  delivery_channel: DeliveryChannel | null;
  sms_otp_required: boolean;
  phone_e164: string | null;
  phone_masked?: string | null;
  timezone?: string | null;
}

/** The recipient write of PUT …/recipients (B2 adds witness, access code and identity check). */
export interface RecipientWrite {
  id?: string;
  name: string;
  email: string | null;
  recipient_kind?: RecipientKind;
  copy_delivery?: CopyDelivery | null;
  assign_to_me?: boolean;
  // A WITNESS names the signer it attests for by list position.
  witness_for_index?: number | null;
  // A string sets the code, null clears it, omitted keeps it.
  access_code?: string | null;
  // A value sets the check, null clears it, omitted keeps it.
  identity_verification_method?: IdentityVerificationMethod | null;
}

// E.164 and the access code rule (@aramo/sign-client — the server's own copy).
export const E164_RE = E164_PATTERN;
export const validAccessCode = isValidAccessCode;

// M-A6 §2.1 — the types a sender authors (the server's FIELD_TYPES).
// Sign 1.14 — PAYMENT is authored too (the server refuses it while payments are not available).
export const SENDER_FIELD_TYPES: ReadonlySet<string> = new Set<string>(placeableFieldTypes({ payments_available: true }));

export interface EnvelopeField {
  id?: string;
  // FIELD-PARITY-2 B-1 — the field's stable key on the envelope (the editor's id; null on a legacy
  // field). Sent back on PUT …/fields so it survives the replace-all save.
  field_key?: string | null;
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
  // M-A6 §2 — Name and Checkbox configuration (null where it does not apply).
  name_mode?: 'SIGNER_PROFILE' | 'SIGNER_ENTERED' | null;
  label?: string | null;
  group_key?: string | null;
  group_rule?: 'SELECT_ONE' | 'SELECT_ANY' | null;
  min_selected?: number | null;
  // Sign 1.14 — PAYMENT only: the amount in cents and the currency (USD).
  payment_amount_minor?: number | null;
  payment_currency?: 'USD' | null;
  // FIELD-PARITY-1 P3 §6.2 — the other settings (null / false = not set).
  tooltip?: string | null;
  placeholder?: string | null;
  read_only?: boolean;
  sender_filled?: boolean;
  validation?: string | null;
  font_size?: number | null;
  data_name?: string | null;
  options?: Readonly<Record<string, unknown>> | null;
  // FIELD-PARITY-2 B-2 — "show only when" ({ trigger_key, when, values? }; null = always shown).
  condition?: { readonly trigger_key: string; readonly when: string; readonly values?: readonly string[] } | null;
  // S-5 (ruling R-3, dark) — a sender-filled field's value, the sender's own (null otherwise).
  value?: string | null;
}

/**
 * PUT …/fields — one field as the save sends it. The type's configuration travels with the
 * field; a value never does, except a sender-filled field's own value (FIELD-PARITY-1 P3 S-5,
 * ruling R-3).
 */
export function envelopeFieldToWire({ id, field_key, condition, envelope_document_id, signer_id, field_type, page_number, x, y, width, height, required, name_mode, label, group_key, group_rule, min_selected, payment_amount_minor, payment_currency, tooltip, placeholder, read_only, sender_filled, validation, font_size, data_name, options, value }: EnvelopeField): Record<string, unknown> {
  return {
    // An engine-only type goes back with its stored id, unchanged (the server
    // keeps it only when identical to the stored row). FIELD-PARITY-1 P3 — ACKNOWLEDGEMENT
    // is authorable now, but a stored engine row of it keeps its id (the server passes a
    // row with no recipient or size through unchanged).
    ...(id != null && (!SENDER_FIELD_TYPES.has(field_type) || field_type === 'ACKNOWLEDGEMENT') ? { id } : {}),
    // FIELD-PARITY-2 B-1 / B-2 — the field's key and its "show only when" go back too; the
    // save replaces every field, so a setting left out here is lost (the conditions were).
    ...(field_key != null ? { field_key } : {}),
    envelope_document_id, signer_id, field_type, page_number, x, y, width, height, required,
    ...(name_mode != null ? { name_mode } : {}),
    ...(label != null ? { label } : {}),
    ...(group_key != null ? { group_key } : {}),
    ...(group_rule != null ? { group_rule } : {}),
    ...(min_selected != null ? { min_selected } : {}),
    ...(payment_amount_minor != null ? { payment_amount_minor, payment_currency: payment_currency ?? 'USD' } : {}),
    // FIELD-PARITY-1 P3 — every setting that is set goes back (a stored DROPDOWN keeps its choices).
    ...(tooltip != null ? { tooltip } : {}),
    ...(placeholder != null ? { placeholder } : {}),
    ...(read_only === true ? { read_only } : {}),
    ...(sender_filled === true ? { sender_filled } : {}),
    ...(validation != null ? { validation } : {}),
    ...(font_size != null ? { font_size } : {}),
    ...(data_name != null ? { data_name } : {}),
    ...(options != null ? { options } : {}),
    ...(condition != null ? { condition } : {}),
    // S-5 — the sender's value travels only with a sender-filled field.
    ...(sender_filled === true && value != null ? { value } : {}),
  };
}

// Sign 1.14 — the organization's Stripe Connect account (Settings → Payments).
export interface PaymentAccount {
  available: boolean;
  unavailable_reason: 'feature_not_available' | 'payments_not_configured' | 'plan_not_entitled' | null;
  account: {
    status: 'CONNECTED' | 'DISCONNECTED';
    charges_enabled: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
    live: boolean;
    connected_at: string;
    disconnected_at: string | null;
  } | null;
  application_fee_minor: number;
  can_manage: boolean;
}

// Sign 1.14 — one payment collected on an envelope, with its refunds.
export interface EnvelopePayment {
  id: string;
  signer_id: string;
  field_id: string;
  amount_minor: number;
  currency: 'USD';
  status: 'PENDING' | 'PAID' | 'FAILED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  amount_refunded_minor: number;
  refundable_minor: number;
  payment_ref: string | null;
  paid_at: string | null;
  live: boolean;
  refunds: { id: string; amount_minor: number; status: string; refund_ref: string | null; reason: string | null; created_at: string }[];
}

export function formatUsd(amount_minor: number): string {
  return `$${(amount_minor / 100).toFixed(2)}`;
}

export type RoutingMode = 'PARALLEL' | 'SEQUENTIAL';
export const SUBJECT_LIMIT_NOTE = `Subjects can be up to ${ENVELOPE_SUBJECT_MAX} characters.`;

export interface EnvelopeDetail {
  id: string;
  // M-A12 W1-A / Web Self-Signing A2 — 'self': a document the sender signs alone (no email,
  // no allowance used). Absent on an older server = standard.
  mode?: 'standard' | 'self';
  // Sign Unified Product S-3 — envelopes from another application are read-only here.
  source_application?: string;
  subject: string;
  status: EnvelopeStatus;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  voided_at: string | null;
  // Deprecated server field: the signing-link lifetime (sent_at + the link window), NOT
  // the envelope's expiry. Shown only as "Signing link valid until".
  expires_at: string | null;
  signing_window_days: number;
  // Client Rule Consolidation C0-1 — the envelope's own expiry (absent from an older server).
  envelope_expires_at?: string | null;
  signing_link_valid_days?: number;
  sender: { id: string; name: string | null };
  editable: boolean;
  // Multi-Signer §4 — Sign in any order (PARALLEL) or Sign in order (SEQUENTIAL), and who may sign now.
  routing_mode?: RoutingMode;
  // Feature-Parity §1.17 — signers may hand the envelope to someone else (set in DRAFT).
  allow_delegation?: boolean;
  // SIGN-FREE-PARITY-1 S4 — automatic reminders (absent from an older server).
  auto_reminders?: AutoRemindersView;
  next_signer_id?: string | null;
  // Sign Mobile M-A3 §3 — the sender's plain-text message to recipients (DRAFT only; null = none).
  message?: string | null;
  documents: EnvelopeDocument[];
  recipients: Recipient[];
  fields: EnvelopeField[];
  // Retention and Purge — absent from an older server (read as no purge).
  purge?: PurgeInfo | null;
  // Client Rule Consolidation C1 — what the caller may do (read it with senderActionsOf).
  actions?: SenderActions;
  // FIELD-PARITY-1 P3 S-5 (ruling R-3) — sender-filled fields switched on (the server flag;
  // absent / false: Prepare does not offer them).
  sender_filled_fields_enabled?: boolean;
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
  /** FIELD-PARITY-1 P2-5 / P2-6 — present only on an upload sent with import_fields / apply_text_tags. */
  field_import?: {
    fields: unknown[];
    warnings: { code: string; message: string; name?: string; page_number?: number }[];
    stripped: string[];
  };
}

/** FIELD-PARITY-1 P2-4 — GET …/documents/{documentId}/field-suggestions?detect=all. */
export interface DocumentFieldSuggestions {
  suggestions: { type: string; page: number; page_number: number; x: number; y: number; width: number; height: number; reason?: string; confidence?: number }[];
  skipped_pages?: { page: number; reason: string }[];
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
  // UAT SND-24 — a saved contact has an id (editable); a recent recipient is derived from
  // envelopes (id null, source 'recent') and cannot be edited or deleted.
  id?: string | null;
  source?: 'saved' | 'recent';
  organization?: string | null;
  name: string;
  email: string;
  envelope_count: number;
  last_used_at: string;
}

export interface ContactInput {
  name: string;
  email: string;
  organization: string | null;
}

/** UAT SND-24 — the contact refusals, in the app's words (ContactsSheet CONTACT_ERRORS). */
export const CONTACT_ERRORS: Record<string, string> = {
  invalid_contact_name: 'Enter a name of at most 200 characters.',
  invalid_contact_email: 'Enter a valid email address.',
  invalid_contact_organization: 'The organization can be at most 200 characters.',
  contact_exists: 'You already have a contact with this email.',
  empty_contact_update: 'Change something to save.',
};

export interface ExecutedBundle {
  envelope_id: string;
  documents: { envelope_document_id: string; title: string; executed_sha256: string; byte_size: number; executed_base64: string }[];
  certificate: { certificate_sha256: string; byte_size: number; certificate_base64: string } | null;
}

export interface Evidence {
  envelope_id: string;
  status: string;
  event_chain_hash: string;
  // UAT CMP-05 — the hash printed on the certificate (the chain at completion); null before it.
  certificate_event_chain_hash?: string | null;
  signature: string;
  signature_algorithm: string;
  completed_at: string | null;
}

const enc = encodeURIComponent;

// DOC-TEMPLATE-LIB-1 T-5 — Documents-owned templates as the Sign console uses them. Sign
// holds no template data: sign-service reads them through the Documents API.
export interface TemplateVariable {
  key: string;
  label: string;
  group: string;
  // ORGANIZATION — from the organization profile; SENDER — filled in by the sender.
  source: 'ORGANIZATION' | 'SENDER';
  value: string | null;
}

// Amendment M-A6 §3.2 — a template's signing roles: SIGNER roles sign (one signature block
// each), CC roles receive a copy.
export interface TemplateRole {
  role_key: string;
  label: string;
  kind: 'SIGNER' | 'CC';
  order: number;
}
export interface TemplateSigning {
  roles: TemplateRole[];
  routing_mode: RoutingMode;
  default_subject?: string;
  default_message?: string;
}

export interface SenderTemplate {
  template_id: string;
  name: string;
  description: string | null;
  document_type: { id: string; key: string; name: string };
  owner_scope: 'PLATFORM' | 'TENANT';
  resolution: string;
  // M-A6 §3.1 — the template the organization's automatic choice picks for its type.
  is_default?: boolean;
  version_id: string;
  version_number: number;
  updated_at: string;
  variables: TemplateVariable[];
  // M-A6 §3.7 — list metadata.
  category?: string;
  signer_role_count?: number;
  cc_role_count?: number;
  document_count?: number;
  routing_mode?: RoutingMode;
  signing?: TemplateSigning | null;
  // TEMPLATE-PRODUCT-1 §7.4 — FIXED_FORM = an Aramo fixed legal form (used as it is, never
  // adopted or edited); absent = an editable template.
  template_kind?: 'EDITABLE' | 'FIXED_FORM';
  // TEMPLATE-SYNC-1 S-3 / S-11 — the server-computed master of a template the organization adopted
  // from an Aramo template (null otherwise). Shown as a badge; never recomputed here.
  master?: {
    newer_available: boolean;
    withdrawn: { notice_at: string; effective_at: string; status: 'PENDING' | 'IN_EFFECT' } | null;
    current_version_number: number | null;
    based_on_version_number: number | null;
  } | null;
}

// M-A6 §3.5 — one template role bound to a person.
export interface TemplateRoleBinding {
  role_key: string;
  name: string;
  email: string;
}

export interface TemplatePreview {
  template_id: string;
  version_id: string;
  version_number: number;
  title: string;
  blocks: { type: string; text: string }[];
  html: string | null;
  letterhead: { organization_name: string | null; logo_available: boolean };
  variables: TemplateVariable[];
}

export interface FromTemplateResult {
  envelope: EnvelopeDetail;
  template: { template_id: string; version_id: string; version_number: number };
  // FIELD-PARITY-1 P1-2 — the renderer's signature block: the catalog's `signature_block` projection.
  suggested_fields: { field_type: FieldTypeOn<'signature_block'>; page_number: number; x: number; y: number; width: number; height: number; role_key?: string }[];
  signing?: TemplateSigning | null;
}

// Aramo Sign launch — self-service billing (/v1/sign/billing/*). The backend is
// the only authority for the plan, status and usage; the console only renders
// them and hands the browser to the provider-hosted checkout / portal pages.
const BILLING = '/v1/sign/billing';

export interface Money {
  amount_minor: number;
  currency: string;
  interval?: string | null;
}

// Sign Monthly and Annual-Commitment Pricing v1.0 — a billing term of a plan: both are billed monthly;
// MONTHLY has no commitment, ANNUAL_COMMIT a 12-month commitment at its own (discounted) price.
export type BillingTerm = 'MONTHLY' | 'ANNUAL_COMMIT';
export interface BillingTermOption {
  term: BillingTerm;
  price: { amount_minor: number; currency: string; interval: 'MONTH' };
  commitment_months: number | null;
  default: boolean;
  purchasable: boolean;
  web_only: boolean;
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
  // Sign Business per-seat directive §3.3.4 — how the list price is charged (SEAT = per user).
  // Optional only for older backends; absent reads as ACCOUNT (per organization).
  price_unit?: PriceUnit;
  // India Billing §4.11 — the price shown for the caller's billing region (Stripe: `price`; Razorpay: the
  // regional INR price, null when the plan has none there). Absent on older backends (read `price`).
  display_price?: Money | null;
  // Billing terms — every term the plan sells (MONTHLY first). Absent on older backends (one term derived
  // from price / commitment_months).
  billing_terms?: BillingTermOption[];
}

/** Per-seat directive §3.1 — ACCOUNT = per organization; SEAT = per user (seat). */
export type PriceUnit = 'ACCOUNT' | 'SEAT';

/** Per-seat directive §3.3.4 — the seats of a SEAT subscription (`pending_purchased` = a decrease scheduled for the period end). */
export interface BillingSeats {
  purchased: number;
  used: number;
  pending_purchased: number | null;
}

/** Per-seat directive §3.3.3 — POST /v1/sign/billing/seats. */
export interface BillingSeatsChange extends BillingSeats {
  effective: 'NOW' | 'PERIOD_END';
}

export interface BillingCatalog {
  plans: BillingPlan[];
  terms: { version: string; url: string } | null;
  sales_contact_url: string | null;
  // India Billing Regions + Razorpay (directive v1.0 §4.11) — the caller's billing region: its web
  // gateway and currency. Absent on older backends (read as STRIPE / USD).
  billing_gateway?: 'STRIPE' | 'RAZORPAY';
  billing_currency?: string;
}

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE';

export interface BillingAccount {
  subscription: {
    plan_key: string;
    plan_name: string;
    source: 'MANUAL' | 'DEVELOPMENT' | 'SELF_SERVICE' | 'FREE';
    status: SubscriptionStatus;
    sending: boolean;
    started_at: string;
    ended_at: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    grace_until: string | null;
    billing_managed: boolean;
    // CCP-PERSONAL-ARRANGED-1 P-7 — the plan is arranged with Aramo (no price, commitment, term or
    // billing controls are shown for it). Absent on older backends.
    arranged?: boolean;
    commitment_months?: number | null;
    // Billing terms — the term the subscription is on (absent on older backends).
    term?: BillingTerm | null;
    commitment_end?: string | null;
    cancel_requested_within_commitment?: boolean;
    eligibility_state?: 'OK' | 'LAPSED' | null;
    list_price?: Money | null;
    features?: { feature_key: string; enabled: boolean }[];
    export_access_until?: string | null;
  } | null;
  allowance:
    | {
        subscribed: true;
        plan_key: string;
        allowance_key: string;
        limit: number | null;
        unlimited?: boolean;
        used: number;
        remaining: number | null;
        period_start: string;
        period_end: string;
        threshold: 'OK' | 'WARNING' | 'EXHAUSTED';
        // Aramo Sign Personal (Free) — the daily window on top of the monthly allowance.
        // The window is any 24 hours; next_available_at is when the oldest counted send leaves it.
        daily?: { window?: 'DAY'; limit: number; used: number; remaining?: number | null; next_available_at?: string | null } | null;
      }
    | { subscribed: false; allowance_key: string; state?: 'NONE' | 'PAST_DUE' | 'INCOMPLETE' | 'CANCELED' };
  storage?: { capacity_key: string; limit: number | null; unlimited: boolean; used: number } | null;
  billing_available: boolean;
  tenant_kind: string;
  self_service_eligible: boolean;
  can_manage_billing: boolean;
  // Catalog v2 directive (fc755040…) §4.3 — the in-place Personal upgrade (Free → Standard), when
  // the backend offers one. Absent on older backends; null when the feature is off or no upgrade
  // applies; `reason` says why it isn't available (e.g. not_available_in_country).
  // India Billing §4.11 — `currency` of price_minor and the `billing_gateway` of the checkout (absent: USD / STRIPE).
  upgrade?: {
    available: boolean;
    plan_key: string;
    price_minor: number | null;
    commitment_months: number | null;
    reason?: string | null;
    currency?: string | null;
    billing_gateway?: 'STRIPE' | 'RAZORPAY';
    // Billing terms — the offer's terms (absent on older backends).
    billing_terms?: BillingTermOption[];
  } | null;
  // M-A12 A1-2 — where the open plan is billed (STRIPE / RAZORPAY: on the web; a store: in the app).
  // India Billing §4.11 — a RAZORPAY plan has no provider portal: Aramo's own manage section is shown.
  managed_by?: 'STRIPE' | 'RAZORPAY' | 'APP_STORE' | 'GOOGLE_PLAY' | null;
  // India Billing §4.11 — the current plan's price for its billing region (Razorpay: the regional price).
  display_price?: Money | null;
  // Sign Business per-seat directive §3.3.4 — the pinned version's pricing unit (null: no
  // subscription), its seats (null unless SEAT), and whether the caller may change them (owner /
  // admin, Stripe-billed, SEAT; O-3). Optional only for older backends.
  price_unit?: PriceUnit | null;
  seats?: BillingSeats | null;
  can_manage_seats?: boolean;
}

export const billingApi = {
  plans: () => apiClient.get<BillingCatalog>(`${BILLING}/plans`),
  account: () => apiClient.get<BillingAccount>(`${BILLING}/account`),
  // Per-seat directive §3.3.1 — `seats` only for a SEAT plan (the backend refuses it otherwise).
  // Billing terms — `term` chooses MONTHLY or ANNUAL_COMMIT (omitted: the plan's default term).
  checkout: (plan_key: string, accept_terms?: boolean, seats?: number, term?: BillingTerm) =>
    apiClient.post<{ url: string }>(`${BILLING}/checkout`, {
      plan_key,
      ...(accept_terms === undefined ? {} : { accept_terms }),
      ...(seats === undefined ? {} : { seats }),
      ...(term === undefined ? {} : { term }),
    }),
  // Per-seat directive §3.3.3 — change the seat count (owner / admin): an increase is prorated now,
  // a decrease applies at the period end; never below the seats in use.
  seats: (seats: number) => apiClient.post<BillingSeatsChange>(`${BILLING}/seats`, { seats }),
  portal: () => apiClient.post<{ url: string }>(`${BILLING}/portal`, {}),
  // CCP-C7 — tenant self-service. Remaining-Work A4: Settings → Billing → Cancel subscription uses
  // selfService + selfServiceCancel (CancelSubscription.tsx); selfServiceUpgrade has no screen yet.
  selfService: () => apiClient.get<SelfServiceBilling>(`${BILLING}/self-service`),
  selfServiceCancel: () => apiClient.post<SelfServiceBillingAccepted>(`${BILLING}/self-service/cancel`, {}),
  selfServiceUpgrade: (plan_key: string) => apiClient.post<SelfServiceBillingAccepted>(`${BILLING}/self-service/upgrade`, { plan_key }),
  // Sign Feature Parity D-2 (A1) — metered usage of the current billing period (dark: enabled false).
  usage: () => apiClient.get<BillingUsage>(`${BILLING}/usage`),
};

// Sign Feature Parity D-2 (A1) — GET /v1/sign/billing/usage. While metered billing is off
// (SIGN_USAGE_BILLING_ENABLED unset) the backend answers { enabled: false, period: null } and the
// console shows nothing. Amounts are minor units of `currency`; a null unit price = not sold on the
// current plan (usage recorded earlier in the period still shows).
export interface BillingUsageUnit {
  unit_key: string;
  name: string;
  quantity_label: string;
  quantity: number;
  unit_price_minor: number | null;
  amount_minor: number;
}
export interface BillingUsage {
  enabled: boolean;
  period: { start: string; end: string; currency: string; units: BillingUsageUnit[]; total_amount_minor: number } | null;
}

// CCP-C7 — GET /v1/sign/billing/self-service. While the Sign Terms of Service are not APPROVED every
// action reads { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' } (the designed disabled state).
export interface SelfServiceActionState {
  available: boolean;
  reason: string | null;
}
export interface SelfServiceBilling {
  product_key: 'sign';
  terms: { state: 'APPROVED' | 'NOT_APPROVED'; document_key: string; version: string | null; url: string | null };
  subscription: { plan_key: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean; commitment_end: string | null } | null;
  pending_provider: boolean;
  pending_changes: { action: 'CANCEL_AT_PERIOD_END'; state: 'PENDING_PROVIDER' | 'CONFIRMED'; requested_at: string; confirmed_at: string | null }[];
  actions: { cancel: SelfServiceActionState; upgrade: SelfServiceActionState };
  can_manage_billing: boolean;
}
export interface SelfServiceBillingAccepted {
  request_id: string;
  action: 'CANCEL_AT_PERIOD_END';
  status: 'PENDING_PROVIDER' | 'CONFIRMED';
  pending_provider: boolean;
  replayed: boolean;
}

// Aramo Sign Personal (Free) — the current legal documents the signed-in user still
// has to accept (/v1/sign/legal). Business accounts always get `pending: []`.
export interface PendingLegalDocument {
  key: string;
  version: string;
  url: string;
  title: string;
}

// Privacy Notice 1.1 E-6 — an upcoming version of a legal document (future effective date),
// shown as a dismissible notice. `recordNotice` logs that it was shown or dismissed (delivery evidence).
export interface UpcomingLegalNotice {
  key: string;
  title: string;
  version: string;
  effective_date: string;
  url: string;
  current_version: string;
  current_url: string;
}

export const legalApi = {
  notices: () => apiClient.get<{ notices: UpcomingLegalNotice[] }>('/v1/sign/legal/notices'),
  recordNotice: (n: { key: string; version: string }, event: 'SHOWN' | 'ACKNOWLEDGED') =>
    apiClient.post<{ notices: UpcomingLegalNotice[] }>('/v1/sign/legal/notices/record', { key: n.key, version: n.version, event }),
  status: () => apiClient.get<{ pending: PendingLegalDocument[] }>('/v1/sign/legal/status'),
  accept: (docs: readonly { key: string; version: string }[]) =>
    apiClient.post<{ pending: PendingLegalDocument[] }>('/v1/sign/legal/accept', { accept: docs.map((d) => ({ key: d.key, version: d.version })) }),
};

// Aramo Sign Personal (Free) — Settings → Close account (/v1/sign/account). `closable`
// is true only for the owner of an open Personal account (backend-decided).
export interface AccountStatus {
  closable: boolean;
  closed: boolean;
  closed_at: string | null;
}

export const accountApi = {
  status: () => apiClient.get<AccountStatus>('/v1/sign/account/status'),
  close: (reason?: string) =>
    apiClient.post<{ state: 'closed'; closed_at: string }>('/v1/sign/account/close', reason !== undefined && reason.trim() !== '' ? { confirm: 'CLOSE', reason: reason.trim() } : { confirm: 'CLOSE' }),
};

// Aramo-Sign-Mobile-Amendment-M-A7 §3 — privacy requests (deletion, access, export,
// correction). Signed in: the caller's own requests. Public (no session): the
// /delete-account flow — start (always 202), verify (the token from the link's URL
// fragment, in the body only) and status by reference + email.
export type PrivacyRequestType = 'DELETION' | 'ACCESS' | 'EXPORT' | 'CORRECTION';
export interface PrivacyRequestView {
  reference: string;
  request_type: PrivacyRequestType;
  subject_kind: string;
  channel: string;
  status: string;
  status_label: string;
  referred_to_organization: boolean;
  due_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  outcome_code: string | null;
  outcome_text: string | null;
  retained: { key: string; label: string; why: string }[];
  organization_decides: string | null;
  privacy_contact: string;
}
export const privacyApi = {
  mine: () => apiClient.get<{ items: PrivacyRequestView[] }>('/v1/sign/me/privacy-requests'),
  request: (request_type: PrivacyRequestType) =>
    apiClient.post<PrivacyRequestView>('/v1/sign/me/privacy-requests', request_type === 'DELETION' ? { request_type, confirm: 'DELETE' } : { request_type }),
};

// ORG-UX-1 §6 — Sign member role administration is retired (Organization owns roles).

export const senderApi = {
  context: () => apiClient.get<SenderContext>(`${BASE}/context`),
  summary: () => apiClient.get<Summary>(`${BASE}/summary`),
  list: (q: { tab?: string; q?: string; days?: number; folder?: 'deleted' } = {}) => {
    const p = new URLSearchParams();
    if (q.folder !== undefined) p.set('folder', q.folder);
    if (q.tab !== undefined && q.tab !== 'all') p.set('tab', q.tab);
    if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
    if (q.days !== undefined) p.set('days', String(q.days));
    const qs = p.toString();
    return apiClient.get<EnvelopeList>(`${BASE}/envelopes${qs === '' ? '' : `?${qs}`}`);
  },
  // Web Self-Signing A2 — `mode: 'self'` creates a SELF draft whose only signer is the caller.
  create: (subject?: string, mode?: 'standard' | 'self') =>
    apiClient.post<{ id: string; status: EnvelopeStatus; subject: string }>(`${BASE}/envelopes`, {
      ...(subject !== undefined ? { subject } : {}),
      ...(mode === 'self' ? { mode } : {}),
    }),
  detail: (id: string) => apiClient.get<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`),
  rename: (id: string, subject: string) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { subject }),
  setRouting: (id: string, routing_mode: RoutingMode) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { routing_mode }),
  // Sign Mobile M-A3 §3 — the sender message (server sanitizes; > ENVELOPE_MESSAGE_MAX is refused; null clears).
  setMessage: (id: string, message: string | null) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { message }),
  events: (id: string) => apiClient.get<{ items: LedgerEvent[] }>(`${BASE}/envelopes/${enc(id)}/events`),
  // FIELD-PARITY-1 P2-5 / P2-6 — `options` holds only the ticked flags; without them the body is unchanged.
  upload: (id: string, file: { filename: string; title: string; content_base64: string }, options: { import_fields?: true; apply_text_tags?: true } = {}) =>
    apiClient.post<UploadedDocument>(`${BASE}/envelopes/${enc(id)}/documents`, { ...file, ...options }),
  // FIELD-PARITY-1 P2-4 — the deterministic detector (labels, lines, boxes, glyphs) for Prepare.
  fieldSuggestions: (id: string, docId: string) =>
    apiClient.get<DocumentFieldSuggestions>(`${BASE}/envelopes/${enc(id)}/documents/${enc(docId)}/field-suggestions?detect=all`),
  renameDocument: (id: string, docId: string, title: string) =>
    apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/${enc(docId)}`, { title }),
  reorderDocuments: (id: string, order: string[]) => apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/order`, { order }),
  removeDocument: (id: string, docId: string) => apiClient.delete<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/documents/${enc(docId)}`),
  recipients: (id: string, recipients: RecipientWrite[]) => apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/recipients`, { recipients }),
  // Feature-Parity §1.17 — allow signers to delegate (DRAFT; refused while not available).
  setAllowDelegation: (id: string, allow_delegation: boolean) => apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}`, { allow_delegation }),
  // SIGN-FREE-PARITY-1 S4 — automatic reminders on or off (while drafting and after sending).
  setAutoReminders: (id: string, auto_reminders_enabled: boolean) =>
    apiClient.patch<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/reminders`, { auto_reminders_enabled }),
  // Feature-Parity §1.7–§1.9 — text delivery and the SMS code, per recipient (no envelope revision change).
  messaging: (id: string) => apiClient.get<{ envelope_id: string; recipients: RecipientMessaging[] }>(`${BASE}/envelopes/${enc(id)}/messaging`),
  setMessaging: (id: string, signerId: string, body: { delivery_channel: DeliveryChannel | null; sms_otp_required: boolean; phone_e164?: string }) =>
    apiClient.put<RecipientMessaging>(`${BASE}/envelopes/${enc(id)}/recipients/${enc(signerId)}/messaging`, body),
  fields: (id: string, fields: EnvelopeField[]) =>
    apiClient.put<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/fields`, { fields: fields.map(envelopeFieldToWire) }),
  send: (id: string, subject?: string) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/send`, subject !== undefined ? { subject } : {}),
  // signer_id — remind one signer; omitted, everyone who may sign now.
  remind: (id: string, signer_id?: string) =>
    apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/remind`, signer_id !== undefined ? { signer_id } : {}),
  // M-A5 §4 / Web Self-Signing directive W1 — a SELF session for the recipient assigned to
  // the caller. The token is a signing capability: used once to open /s/:token, never stored.
  selfSignSession: (id: string, signer_id?: string) =>
    apiClient.post<{ session_origin: 'SELF'; signer_id: string; token: string; expires_at: string }>(
      `${BASE}/envelopes/${enc(id)}/self-sign-session`,
      signer_id !== undefined ? { signer_id } : {},
    ),
  void: (id: string, reason: string) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/void`, { reason }),
  executed: (id: string) => apiClient.get<ExecutedBundle>(`${BASE}/envelopes/${enc(id)}/executed`),
  // Retention and Purge (DocuSign parity). Delete hides the envelope for this organization only
  // (the Deleted folder); Restore brings it back until a purge has run.
  deleteEnvelope: (id: string) => apiClient.post<{ deleted: true }>(`${BASE}/envelopes/${enc(id)}/delete`, {}),
  // A draft is removed outright with its documents (409 envelope_not_draft once sent).
  deleteDraft: (id: string) => apiClient.delete<undefined>(`${BASE}/envelopes/${enc(id)}`),
  restoreEnvelope: (id: string) => apiClient.post<{ restored: true }>(`${BASE}/envelopes/${enc(id)}/restore`, {}),
  queuePurge: (id: string, level: PurgeLevel) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/purge`, { level }),
  dequeuePurge: (id: string) => apiClient.post<EnvelopeDetail>(`${BASE}/envelopes/${enc(id)}/purge/dequeue`, {}),
  targetedPurge: (email: string, level: PurgeLevel) => apiClient.post<{ queued: number }>(`${BASE}/purge/targeted`, { email, level }),
  retentionPolicy: () => apiClient.get<RetentionPolicy>(`${BASE}/retention-policy`),
  setRetentionPolicy: (retention_days: number | null, purge_level: PurgeLevel) =>
    apiClient.put<RetentionPolicy>(`${BASE}/retention-policy`, { retention_days, purge_level }),
  evidence: (id: string) => apiClient.get<Evidence>(`${BASE}/envelopes/${enc(id)}/evidence`),
  // Sign 1.14 — payments through Stripe Connect (the organization's own Stripe account).
  paymentAccount: () => apiClient.get<PaymentAccount>(`${BASE}/payments/account`),
  paymentOnboardingLink: () => apiClient.post<{ url: string; expires_at: string }>(`${BASE}/payments/account/onboarding-link`, {}),
  refreshPaymentAccount: () => apiClient.post<PaymentAccount>(`${BASE}/payments/account/refresh`, {}),
  disconnectPaymentAccount: () => apiClient.post<PaymentAccount>(`${BASE}/payments/account/disconnect`, {}),
  envelopePayments: (id: string) => apiClient.get<{ items: EnvelopePayment[]; can_refund: boolean }>(`${BASE}/envelopes/${enc(id)}/payments`),
  refundPayment: (id: string, paymentId: string, body: { amount_minor?: number; reason?: string }) =>
    apiClient.post<EnvelopePayment>(`${BASE}/envelopes/${enc(id)}/payments/${enc(paymentId)}/refund`, body),
  documents: () => apiClient.get<{ items: DocumentRow[] }>(`${BASE}/documents`),
  contacts: () => apiClient.get<{ items: ContactRow[] }>(`${BASE}/contacts`),
  // UAT SND-24 (web ≡ app) — edit and delete a saved contact.
  updateContact: (id: string, input: ContactInput) => apiClient.patch<ContactRow>(`${BASE}/contacts/${enc(id)}`, input),
  deleteContact: async (id: string): Promise<void> => {
    await apiClient.delete<undefined>(`${BASE}/contacts/${enc(id)}`);
  },
  activity: (limit = 200) => apiClient.get<{ items: LedgerEvent[] }>(`${BASE}/activity?limit=${limit}`),
  // DOC-TEMPLATE-LIB-1 T-5 — templates (Documents-owned) and envelopes started from one.
  templates: () => apiClient.get<{ items: SenderTemplate[]; unavailable: { document_type_id: string; reason: string }[] }>(`${BASE}/templates`),
  previewTemplate: (id: string, values: Record<string, string>) => apiClient.post<TemplatePreview>(`${BASE}/templates/${enc(id)}/preview`, { values }),
  fromTemplate: (body: {
    template_id: string;
    values: Record<string, string>;
    subject?: string;
    idempotency_key?: string;
    signer?: { name: string; email: string };
    // M-A6 §3.5 — role binding (mutually exclusive with signer).
    recipients?: TemplateRoleBinding[];
    cc?: TemplateRoleBinding[];
    routing_mode?: RoutingMode;
    message?: string | null;
  }) => apiClient.post<FromTemplateResult>(`${BASE}/envelopes/from-template`, body),
};

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED) §1.13 — organization reports.
export type ReportPeriod = 'day' | 'week' | 'month';
export interface ReportStats {
  sent: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
  in_flight: number;
  completion_rate: number | null;
  turnaround_average_hours: number | null;
  turnaround_median_hours: number | null;
  turnaround_p90_hours: number | null;
}
export interface ReportsOverview {
  range: { from: string; to: string; period: ReportPeriod; timezone: 'UTC' };
  totals: ReportStats;
  volume: { period_start: string; sent: number; completed: number; declined: number; voided: number }[];
  by_sender: (ReportStats & { sender_id: string; sender_name: string | null })[];
  by_template: (ReportStats & { template_ref: string | null; template_name: string | null })[];
}
export interface ReportQuery {
  from?: string;
  to?: string;
  period?: ReportPeriod;
}
export type ReportExportKind = 'summary' | 'volume' | 'senders' | 'templates';

function reportQs(q: ReportQuery & { report?: ReportExportKind }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && v !== '') p.set(k, v);
  const qs = p.toString();
  return qs === '' ? '' : `?${qs}`;
}

export const reportsApi = {
  overview: (q: ReportQuery = {}) => apiClient.get<ReportsOverview>(`${BASE}/reports/overview${reportQs(q)}`),
  exportUrl: (kind: ReportExportKind, q: ReportQuery = {}) => `${BASE}/reports/export${reportQs({ ...q, report: kind })}`,
  auditUrl: (q: ReportQuery = {}) => `${BASE}/reports/envelopes/export${reportQs({ from: q.from, to: q.to })}`,
};

// A CSV attachment (reports exports): same credentials, consumer header and one-shot refresh
// as fetchSourcePdf; saved under the server's filename.
export async function downloadCsv(url: string, fallbackName: string): Promise<void> {
  const get = () => fetch(url, { credentials: 'include', headers: { 'X-Aramo-Consumer': getAuthConsumer() } });
  let res = await get();
  if (res.status === 401) {
    const refreshed = await fetch(`/auth/${getAuthConsumer()}/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) res = await get();
  }
  if (!res.ok) {
    let code: string | undefined;
    let message = `Could not export (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message, code);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

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

/** "Nov 30, 2026" in the viewer's locale, or null for a missing/invalid date. */
function localDate(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

/**
 * Client Rule Consolidation C3 (audit row 29) — the user copy for a refusal, from the ONE map
 * in @aramo/sign-client (the Aramo Sign app shows the same words). The server's own message
 * text is never shown: an unmapped refusal gets `fallback`.
 */
export function errorMessage(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = e.details?.['reason'];
  return refusalMessage(
    { code: e.code ?? '', reason: typeof reason === 'string' ? reason : null, status: e.status, details: e.details ?? null },
    { time: nextSendTime, date: localDate },
    fallback,
  );
}

/**
 * UAT SND-23 — a reminder refused because the envelope changed elsewhere since it was
 * read (voided, completed, declined or expired on another device, or every signer done):
 * 409 ESIGN_REMINDER_NOT_ALLOWED with no reason.
 */
export function isReminderStale(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const reason = e.details?.['reason'];
  return sharedReminderStale({ code: e.code ?? '', status: e.status, reason: typeof reason === 'string' ? reason : null });
}

/** Per-seat directive §3.5.2 — the member cap of a per-seat plan (409, details.reason = seat_limit_reached). */
export function isSeatLimitReached(e: unknown): e is ApiError {
  return e instanceof ApiError && e.details?.['reason'] === SEAT_LIMIT_REASON;
}

// Sign Unified Product S-7 — the recipient inbox (/v1/sign/inbox). A recipient
// right: available to any signed-in Aramo Sign user, limited to their own
// recipient bindings and (W2) the envelopes the server lists for their verified
// account email.
export interface InboxItem {
  // A binding id (source 'bound') or an opaque, short-lived server handle (source
  // 'discovered'). Never parsed: only passed back to /v1/sign/inbox/{id}/*.
  id: string;
  // W2 — absent from an older server (read as 'bound').
  source?: 'bound' | 'discovered';
  // W2 — the signed-in user also sent this envelope.
  i_am_sender?: boolean;
  subject: string;
  from: string | null;
  envelope_status: EnvelopeStatus;
  // W2 (A3.2) — 'upcoming': the signed-in user signs later in the order (can_sign false).
  my_status: RecipientStatus | 'upcoming';
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  signed_at: string | null;
  can_sign: boolean;
  can_download: boolean;
  // Client Rule Consolidation C1 — what the user may do with this item (read it with inboxActionsOf).
  actions?: InboxActions;
}

export const inboxApi = {
  list: () => apiClient.get<{ waiting: InboxItem[]; completed: InboxItem[]; other: InboxItem[] }>('/v1/sign/inbox'),
  claim: (token: string) => apiClient.post<{ id: string }>('/v1/sign/inbox/claim', { token }),
  sign: (id: string) => apiClient.post<{ signing_url: string }>(`/v1/sign/inbox/${encodeURIComponent(id)}/sign`),
  signedCopy: (id: string) => apiClient.post<{ download_url: string }>(`/v1/sign/inbox/${encodeURIComponent(id)}/signed-copy`),
  remove: (id: string) => apiClient.delete<{ removed: boolean }>(`/v1/sign/inbox/${encodeURIComponent(id)}`),
  // M-A17 — "Delete from my inbox" (any received item, any state) and Restore; the Deleted folder.
  removeFromInbox: (id: string) => apiClient.post<{ removed: boolean }>(`/v1/sign/inbox/${encodeURIComponent(id)}/remove-from-inbox`, {}),
  returnToInbox: (id: string) => apiClient.post<{ restored: boolean }>(`/v1/sign/inbox/${encodeURIComponent(id)}/return-to-inbox`, {}),
  deleted: () => apiClient.get<{ waiting: InboxItem[]; completed: InboxItem[]; other: InboxItem[] }>('/v1/sign/inbox?folder=deleted'),
};

// W2 (A3.4) — the inbox item named in the request is gone (an expired or changed
// discovered item): the page reloads the inbox once and says so (INBOX_ITEM_CHANGED).
export function isInboxItemNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404 && e.details?.['reason'] === 'inbox_item_not_found';
}
// W2 (A3.2) — the user signs later in the order: shown under "Upcoming", never under To sign.
export function isUpcoming(i: InboxItem): boolean {
  return i.my_status === 'upcoming';
}

// The capability token from a pasted signing link (…/s/<token>) or a bare token.
export function tokenFromSigningLink(input: string): string | null {
  const v = input.trim();
  const m = /\/s\/([A-Za-z0-9_-]{20,})/.exec(v);
  if (m !== null && m[1] !== undefined) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null;
}

/** "Oct 22, 9:14 AM" in the viewer's locale and time zone, or null for a missing/invalid time. */
export function nextSendTime(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** An allowance refusal (daily or monthly) — a Personal account is offered the Business route. */
export function isAllowanceLimit(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ESIGN_ALLOWANCE_EXHAUSTED';
}

// M-A5 §1 — a copy recipient never signs (no fields, no turn, never blocks sending).
export function isCopyRecipient(r: { recipient_kind?: RecipientKind }): boolean {
  return r.recipient_kind === 'RECEIVES_COPY';
}

// UAT SIG-05 — the signed-in user's default signature and initials (Sign Mobile M-A3 §4:
// /v1/sign/me/signature and /v1/sign/me/initials, "web and mobile alike"). Keyed by the
// session's (tenant, user); the same defaults the Aramo Sign app offers when signing.
export interface SavedMark {
  kind: 'TYPED' | 'DRAWN';
  typed_name: string | null;
  font_key: string | null;
  image_data_url: string;
  updated_at: string;
}
export interface SavedMarks {
  signature: SavedMark | null;
  initials: SavedMark | null;
}
export type SavedMarkTarget = 'signature' | 'initials';
// UAT SIG-12 — the sender's SIGN_DATE format, stamped on envelopes they send (M-A12 W1-E.2).
export type SavedMarkWrite =
  | { kind: 'TYPED'; typed_name: string; font_key: string; image_data_url: string }
  | { kind: 'DRAWN'; image_data_url: string };
// The font key the app sends with a typed mark (mobile adopt.ts SCRIPT_FONT_KEY).
export const SAVED_MARK_FONT_KEY = 'system-script';
// M-A15 §5 — the user's Sign settings; the opt-out is optional on PUT.
export interface SignMeSettings {
  date_format: string;
  default_field_size: string;
  offer_saved_signature_on_links?: boolean;
}
// UAT PRF-01 — the user's Sign profile (M-A12 W1-E; GET/PUT /v1/sign/me/profile), the
// same record the app's My profile edits. Optional fields are null when empty.
export interface SignProfile {
  display_name: string;
  title: string | null;
  company: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  email?: string | null;
  updated_at?: string | null;
}
export const profileApi = {
  get: () => apiClient.get<SignProfile>('/v1/sign/me/profile'),
  put: (p: Omit<SignProfile, 'email' | 'updated_at'>) => apiClient.put<SignProfile>('/v1/sign/me/profile', p),
};

export const savedMarksApi = {
  get: () => apiClient.get<SavedMarks>('/v1/sign/me/signature'),
  settings: () => apiClient.get<SignMeSettings>('/v1/sign/me/settings'),
  putSettings: (s: SignMeSettings) => apiClient.put<SignMeSettings>('/v1/sign/me/settings', s),
  // Change some settings: read the current values first so one card never writes back
  // another card's stale value (the PUT needs date_format and default_field_size).
  updateSettings: async (patch: Partial<SignMeSettings>): Promise<SignMeSettings> => {
    const cur = await apiClient.get<SignMeSettings>('/v1/sign/me/settings');
    return apiClient.put<SignMeSettings>('/v1/sign/me/settings', { ...cur, ...patch });
  },
  put: (target: SavedMarkTarget, body: SavedMarkWrite) => apiClient.put<SavedMark>(`/v1/sign/me/${target}`, body),
  remove: (target: SavedMarkTarget) => apiClient.delete<void>(`/v1/sign/me/${target}`),
};
