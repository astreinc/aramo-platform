// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED; PR-1, PR-5,
// PR-8, PR-9, PR-10) — the PURE half of PAYMENT_RECORD: the contractual payment-terms block of a B4
// contract, the PAYMENT_RECORD payload, and the derived payment status. No I/O, no clock (the caller
// passes `now`), and no import from the change-request model (it imports this file).
//
// CCP records that an enterprise payment was received OUTSIDE Aramo (§1). Nothing here computes a
// balance, a ledger, a partial settlement or an invoice: v1 settles exactly one obligation with exactly
// one receipt of the same amount and currency (PR-8), and everything else fails closed.

// ---- Closed sets ------------------------------------------------------------------------------

export const BILLING_MODES = ['PREPAID', 'POSTPAID'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** PR-1: USD in v1. */
export const PAYMENT_TERMS_CURRENCIES = ['USD'] as const;

/** PR-5: descriptive, never proof of settlement. OTHER requires an explanation in `verification`. */
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CHEQUE', 'CARD_EXTERNAL', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** PR-5 / PR-13: MANUAL only; ACCT is reserved for a later amendment. */
export const PAYMENT_RECORD_ORIGINS = ['MANUAL'] as const;

/** §2: the closed operation set. */
export const PAYMENT_RECORD_OPERATIONS = ['RECORD', 'CORRECT'] as const;
export type PaymentRecordOperation = (typeof PAYMENT_RECORD_OPERATIONS)[number];

/** PR-9: a correction replaces the evidence, or voids the record (no replacement). */
export const PAYMENT_CORRECTIONS = ['REPLACE', 'VOID'] as const;
export type PaymentCorrection = (typeof PAYMENT_CORRECTIONS)[number];

/** PR-1: mandatory for PREPAID; the receipt's provisional obligation ref (§4.2). */
export const INITIAL_OBLIGATION_REF = 'INITIAL';

export const OBLIGATION_REF_PATTERN = /^[A-Z][A-Z0-9_-]{0,39}$/;
/** The B4 contract ref (commercial-contract.ts CONTRACT_REF_PATTERN), restated to keep this file import-free. */
const CONTRACT_REF = /^[A-Z][A-Z0-9-]{2,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const PAYMENT_TERMS_MAX_OBLIGATIONS = 120;
export const GRACE_DAYS_MAX = 3650;

/** The stable codes of a refused payment-terms / PAYMENT_RECORD payload (the prefix of each error line). */
export const PAYMENT_PAYLOAD_CODES = [
  'PAYMENT_TERMS_REQUIRED',
  'BILLING_MODE_REQUIRED',
  'POSTPAID_APPROVAL_REQUIRED',
  'INITIAL_OBLIGATION_REQUIRED',
  'PAYMENT_TIMEZONE_INVALID',
  'PAYMENT_VERIFICATION_REQUIRED',
  'PAYMENT_ORIGIN_RESERVED',
] as const;

// ---- Types ------------------------------------------------------------------------------------

export interface PaymentObligationTerm {
  obligation_ref: string;
  /** A calendar date (YYYY-MM-DD) in the contract's `timezone`. */
  due_date: string;
  amount_minor: number;
  description: string;
}

export interface PostpaidApproval {
  /** The explicit statement that the contract is postpaid (PR-1: never inferred). */
  statement: string;
  evidence_ref: string;
  documents?: Array<{ name: string; sha256: string; byte_size?: number; media_type?: string }>;
}

/** PR-1 — the structured, immutable payment terms of a B4 contract (bound by the payload checksum). */
export interface PaymentTermsBlock {
  billing_mode: BillingMode;
  postpaid_approval?: PostpaidApproval;
  currency: string;
  timezone: string;
  obligations: PaymentObligationTerm[];
  /** Optional; absent = 0 (PR-1: no default is invented, the absence is kept). */
  grace_days?: number;
}

export interface PaymentEvidence {
  external_invoice_ref: string;
  amount_minor: number;
  currency: string;
  /** A calendar date (YYYY-MM-DD). */
  received_on: string;
  payment_method: PaymentMethod;
  payment_reference: string;
  verification?: string;
  evidence_documents: Array<{ name: string; sha256: string; byte_size?: number; media_type?: string }>;
  origin: 'MANUAL';
}

export type PaymentTarget =
  | { kind: 'CONTRACT_OBLIGATION'; contract_ref: string; obligation_ref: string }
  | { kind: 'PROVISIONAL_INITIAL'; contract_ref: string; obligation_ref: typeof INITIAL_OBLIGATION_REF; expected_amount_minor: number; expected_currency: string };

export type PaymentRecordPayload =
  | ({ operation: 'RECORD'; target: PaymentTarget } & PaymentEvidence)
  | ({ operation: 'CORRECT'; corrects_receipt_id: string; correction: 'REPLACE'; correction_reason: string } & PaymentEvidence)
  | { operation: 'CORRECT'; corrects_receipt_id: string; correction: 'VOID'; correction_reason: string; no_contract_will_follow?: true };

// ---- Small validators -------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function closed(o: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}${at === '' ? '' : '.'}${k} is not a field of this ${at === '' ? 'action' : 'block'}`);
}

function text(v: unknown, at: string, max: number, errors: string[], optional = false): void {
  if (v === undefined && optional) return;
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) errors.push(`${at} must be a non-empty string of at most ${max} characters`);
}

function positiveInt(v: unknown, at: string, errors: string[]): void {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) errors.push(`${at} must be an integer of at least 1 (minor units)`);
}

function documents(v: unknown, at: string, errors: string[], optional = false): void {
  if (v === undefined && optional) return;
  if (!Array.isArray(v) || v.length > 20) {
    errors.push(`${at} must be an array of at most 20 documents`);
    return;
  }
  const seen = new Set<string>();
  v.forEach((d, i) => {
    const p = `${at}[${i}]`;
    if (!isObject(d)) {
      errors.push(`${p} must be an object`);
      return;
    }
    closed(d, ['name', 'sha256', 'byte_size', 'media_type'], p, errors);
    text(d['name'], `${p}.name`, 200, errors);
    if (typeof d['sha256'] !== 'string' || !SHA256_HEX.test(d['sha256'])) errors.push(`${p}.sha256 must be a lowercase SHA-256 hex digest`);
    else if (seen.has(d['sha256'])) errors.push(`${p}.sha256 repeats another document`);
    else seen.add(d['sha256']);
    if (d['byte_size'] !== undefined && (typeof d['byte_size'] !== 'number' || !Number.isSafeInteger(d['byte_size']) || d['byte_size'] < 0)) errors.push(`${p}.byte_size must be a non-negative integer`);
    text(d['media_type'], `${p}.media_type`, 100, errors, true);
  });
}

/** A real calendar date in YYYY-MM-DD form (no time, no zone). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE.exec(v);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** PR-1: an IANA zone name (Area/Location, or UTC), accepted by the runtime's time-zone database. */
export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) return false;
  if (v !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

// ---- PR-1 payment terms -----------------------------------------------------------------------

/**
 * Validates a contract's `payment_terms` block. `required` = the block must be present (a contract
 * record); an amendment carries it optionally.
 */
export function paymentTermsErrors(v: unknown, at: string, errors: string[], required: boolean): void {
  if (v === undefined) {
    if (required) errors.push(`PAYMENT_TERMS_REQUIRED: ${at} is required (billing_mode, currency, timezone, obligations; PR-1)`);
    return;
  }
  if (!isObject(v)) {
    errors.push(`PAYMENT_TERMS_REQUIRED: ${at} must be an object`);
    return;
  }
  closed(v, ['billing_mode', 'postpaid_approval', 'currency', 'timezone', 'obligations', 'grace_days'], at, errors);
  const mode = v['billing_mode'];
  if (mode === undefined || mode === null) errors.push(`BILLING_MODE_REQUIRED: ${at}.billing_mode is required (PREPAID or POSTPAID; never assumed)`);
  else if (!(BILLING_MODES as readonly unknown[]).includes(mode)) errors.push(`BILLING_MODE_REQUIRED: ${at}.billing_mode must be PREPAID or POSTPAID`);
  if (mode === 'POSTPAID') {
    const a = v['postpaid_approval'];
    if (a === undefined) errors.push(`POSTPAID_APPROVAL_REQUIRED: ${at}.postpaid_approval is required for POSTPAID (never inferred from a missing payment)`);
    else if (!isObject(a)) errors.push(`POSTPAID_APPROVAL_REQUIRED: ${at}.postpaid_approval must be an object`);
    else {
      closed(a, ['statement', 'evidence_ref', 'documents'], `${at}.postpaid_approval`, errors);
      text(a['statement'], `POSTPAID_APPROVAL_REQUIRED: ${at}.postpaid_approval.statement`, 1000, errors);
      text(a['evidence_ref'], `POSTPAID_APPROVAL_REQUIRED: ${at}.postpaid_approval.evidence_ref`, 500, errors);
      documents(a['documents'], `${at}.postpaid_approval.documents`, errors, true);
    }
  } else if (v['postpaid_approval'] !== undefined) {
    errors.push(`${at}.postpaid_approval is carried only by a POSTPAID contract`);
  }
  if (!(PAYMENT_TERMS_CURRENCIES as readonly unknown[]).includes(v['currency'])) errors.push(`${at}.currency must be USD (v1)`);
  if (!isIanaTimeZone(v['timezone'])) errors.push(`PAYMENT_TIMEZONE_INVALID: ${at}.timezone must be an IANA time zone (e.g. America/New_York)`);
  if (v['grace_days'] !== undefined && (typeof v['grace_days'] !== 'number' || !Number.isSafeInteger(v['grace_days']) || v['grace_days'] < 0 || v['grace_days'] > GRACE_DAYS_MAX)) {
    errors.push(`${at}.grace_days must be an integer between 0 and ${GRACE_DAYS_MAX} (absent = 0)`);
  }
  const obs = v['obligations'];
  if (!Array.isArray(obs) || obs.length > PAYMENT_TERMS_MAX_OBLIGATIONS) {
    errors.push(`${at}.obligations must be an array of at most ${PAYMENT_TERMS_MAX_OBLIGATIONS} obligations`);
    return;
  }
  const refs = new Set<string>();
  obs.forEach((o, i) => {
    const p = `${at}.obligations[${i}]`;
    if (!isObject(o)) {
      errors.push(`${p} must be an object`);
      return;
    }
    closed(o, ['obligation_ref', 'due_date', 'amount_minor', 'description'], p, errors);
    if (typeof o['obligation_ref'] !== 'string' || !OBLIGATION_REF_PATTERN.test(o['obligation_ref'])) errors.push(`${p}.obligation_ref must match ^[A-Z][A-Z0-9_-]{0,39}$`);
    else if (refs.has(o['obligation_ref'])) errors.push(`${p}.obligation_ref repeats another obligation (unique within the contract)`);
    else refs.add(o['obligation_ref']);
    if (!isCalendarDate(o['due_date'])) errors.push(`${p}.due_date must be a calendar date (YYYY-MM-DD)`);
    positiveInt(o['amount_minor'], `${p}.amount_minor`, errors);
    text(o['description'], `${p}.description`, 500, errors);
  });
  if (mode === 'PREPAID' && !refs.has(INITIAL_OBLIGATION_REF)) errors.push(`INITIAL_OBLIGATION_REQUIRED: ${at}.obligations must include obligation_ref INITIAL for a PREPAID contract`);
}

/** The PREPAID INITIAL obligation of a validated payment-terms block, or null. */
export function initialObligationOf(t: PaymentTermsBlock | undefined): PaymentObligationTerm | null {
  if (t === undefined || t.billing_mode !== 'PREPAID') return null;
  return t.obligations.find((o) => o.obligation_ref === INITIAL_OBLIGATION_REF) ?? null;
}

// ---- PR-5 PAYMENT_RECORD payload --------------------------------------------------------------

const EVIDENCE_KEYS = ['external_invoice_ref', 'amount_minor', 'currency', 'received_on', 'payment_method', 'payment_reference', 'verification', 'evidence_documents', 'origin'] as const;

function evidenceErrors(p: Record<string, unknown>, errors: string[]): void {
  text(p['external_invoice_ref'], 'external_invoice_ref', 200, errors);
  positiveInt(p['amount_minor'], 'amount_minor', errors);
  if (typeof p['currency'] !== 'string' || !/^[A-Z]{3}$/.test(p['currency'])) errors.push('currency must be an ISO 4217 code');
  if (!isCalendarDate(p['received_on'])) errors.push('received_on must be a calendar date (YYYY-MM-DD)');
  if (!(PAYMENT_METHODS as readonly unknown[]).includes(p['payment_method'])) errors.push(`payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  text(p['payment_reference'], 'payment_reference', 200, errors);
  text(p['verification'], 'verification', 2000, errors, true);
  if (p['payment_method'] === 'OTHER' && (typeof p['verification'] !== 'string' || p['verification'].trim().length === 0)) {
    errors.push('PAYMENT_VERIFICATION_REQUIRED: payment_method OTHER requires a non-empty explanation in verification');
  }
  documents(p['evidence_documents'], 'evidence_documents', errors);
  if (p['origin'] !== 'MANUAL') errors.push(p['origin'] === 'ACCT' ? 'PAYMENT_ORIGIN_RESERVED: origin ACCT is reserved (PR-13); only MANUAL is recorded' : 'origin must be MANUAL');
}

/** The full PAYMENT_RECORD schema (closed key sets per operation); returns the error lines. */
export function paymentRecordPayloadErrors(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const op = p['operation'];
  if (op === 'RECORD') {
    closed(p, ['operation', 'target', ...EVIDENCE_KEYS], '', errors);
    const t = p['target'];
    if (!isObject(t)) errors.push('target must be an object');
    else if (t['kind'] === 'CONTRACT_OBLIGATION') {
      closed(t, ['kind', 'contract_ref', 'obligation_ref'], 'target', errors);
      if (typeof t['contract_ref'] !== 'string' || !CONTRACT_REF.test(t['contract_ref'])) errors.push('target.contract_ref must match ^[A-Z][A-Z0-9-]{2,39}$');
      if (typeof t['obligation_ref'] !== 'string' || !OBLIGATION_REF_PATTERN.test(t['obligation_ref'])) errors.push('target.obligation_ref must match ^[A-Z][A-Z0-9_-]{0,39}$');
    } else if (t['kind'] === 'PROVISIONAL_INITIAL') {
      closed(t, ['kind', 'contract_ref', 'obligation_ref', 'expected_amount_minor', 'expected_currency'], 'target', errors);
      if (typeof t['contract_ref'] !== 'string' || !CONTRACT_REF.test(t['contract_ref'])) errors.push('target.contract_ref must match ^[A-Z][A-Z0-9-]{2,39}$');
      if (t['obligation_ref'] !== INITIAL_OBLIGATION_REF) errors.push('target.obligation_ref must be INITIAL (the provisional identity is prepaid INITIAL only, §4.2)');
      positiveInt(t['expected_amount_minor'], 'target.expected_amount_minor', errors);
      if (!(PAYMENT_TERMS_CURRENCIES as readonly unknown[]).includes(t['expected_currency'])) errors.push('target.expected_currency must be USD (v1)');
    } else {
      errors.push('target.kind must be CONTRACT_OBLIGATION or PROVISIONAL_INITIAL');
    }
    evidenceErrors(p, errors);
  } else if (op === 'CORRECT') {
    if (typeof p['corrects_receipt_id'] !== 'string' || !UUID.test(p['corrects_receipt_id'])) errors.push('corrects_receipt_id must be a uuid');
    text(p['correction_reason'], 'correction_reason', 2000, errors);
    if (p['correction'] === 'REPLACE') {
      closed(p, ['operation', 'corrects_receipt_id', 'correction', 'correction_reason', ...EVIDENCE_KEYS], '', errors);
      evidenceErrors(p, errors);
    } else if (p['correction'] === 'VOID') {
      closed(p, ['operation', 'corrects_receipt_id', 'correction', 'correction_reason', 'no_contract_will_follow'], '', errors);
      if (p['no_contract_will_follow'] !== undefined && p['no_contract_will_follow'] !== true) errors.push('no_contract_will_follow must be true when present');
    } else {
      errors.push('correction must be REPLACE or VOID');
    }
  } else {
    errors.push('operation must be RECORD or CORRECT');
  }
  return errors;
}

// ---- PR-10 derived payment status ---------------------------------------------------------------

export const OBLIGATION_PAYMENT_STATUSES = ['PAID', 'NOT_DUE', 'DUE', 'PAST_DUE'] as const;
export type ObligationPaymentStatus = (typeof OBLIGATION_PAYMENT_STATUSES)[number];

/** The calendar date (YYYY-MM-DD) of `instant` in the IANA zone `timezone`. */
export function calendarDateIn(timezone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar-date arithmetic (no zone: a date plus whole days). */
export function addCalendarDays(date: string, days: number): string {
  const m = DATE.exec(date);
  if (m === null) throw new Error(`not a calendar date: ${date}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return t.toISOString().slice(0, 10);
}

/**
 * PR-10, with d = due_date and g = grace_days (0 if absent), dates compared as calendar dates in the
 * contract timezone:
 *   PAID      an applied, uncorrected record exists (whatever the date)
 *   NOT_DUE   today < d
 *   DUE       d <= today <= d + g
 *   PAST_DUE  today > d + g
 * Display only: it never sets TenantSubscription.status and has no automatic consequence.
 */
export function obligationPaymentStatus(o: { due_date: string; paid: boolean }, grace_days: number | null | undefined, today: string): ObligationPaymentStatus {
  if (o.paid) return 'PAID';
  if (today < o.due_date) return 'NOT_DUE';
  if (today <= addCalendarDays(o.due_date, grace_days ?? 0)) return 'DUE';
  return 'PAST_DUE';
}

/** FA-4 — the two booleans every platform:billing:read holder may read. */
export function paymentStatusFlags(statuses: readonly ObligationPaymentStatus[]): { payment_due: boolean; payment_overdue: boolean } {
  return { payment_due: statuses.some((s) => s === 'DUE' || s === 'PAST_DUE'), payment_overdue: statuses.some((s) => s === 'PAST_DUE') };
}
