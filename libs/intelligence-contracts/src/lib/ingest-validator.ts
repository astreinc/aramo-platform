import {
  AVAILABILITY_STATUSES,
  CLASS_C_EXACT_KEYS,
  CLASS_C_KEY_FRAGMENTS,
  IDENTIFIER_VERIFICATION_STATUSES,
  INGESTIBLE_ASSERTION_TYPES,
  INGEST_SOURCE_KINDS,
  VERIFICATION_OUTCOME_RESULTS,
  VERIFICATION_OUTCOME_TARGETS,
  WORK_AUTHORIZATION_STATUSES,
} from './admission.js';
import { SOURCE_SYSTEM_IDS } from './events.js';
import type {
  IngestRejectionCode,
  IngestValidationIssue,
  IngestValidationResult,
  TalentErasedRequest,
  TalentIngestRequest,
} from './ingest.js';

// ATI-SEP-1 T2 (ADR-0036 Decision 4) — the STRICT, CLOSED ingestion validator.
//
//   * Unknown keys anywhere → refused (UNKNOWN_KEY → INVALID_REQUEST).
//   * A key that names a document (bytes, files, attachments, storage keys,
//     presigned / document URLs, data URIs, …) anywhere — including inside an
//     unknown subtree — → DOCUMENT_REJECTED. So is any string VALUE that is a
//     URL (outside a PUBLIC_PROFILE_URL payload), a data URI, a cloud-storage
//     URI, a presigned-URL signature, or a long base64-looking blob.
//   * A Class C key (notes, pay, source, hot flag, street address / postal code,
//     requisition / pipeline / submittal / interview data) → CLASS_C_REJECTED.
//   * Precedence of the overall code: DOCUMENT_REJECTED > CLASS_C_REJECTED >
//     INVALID_REQUEST.
//
// Keys are compared after normalization (lowercase, [a-z0-9] only), so
// `storageKey`, `Storage-Key` and `storage_key` are the same key.

const MAX_STRING = 4000;
const MAX_ID = 128;
const ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PARTIAL_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── key classification ───────────────────────────────────────────────────────

export function normalizeIngestKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const DOCUMENT_KEY_FRAGMENTS = [
  'file',
  'attachment',
  'document',
  'presigned',
  'base64',
  'blob',
  'binary',
  'bytes',
  'storagekey',
  'objectkey',
  's3key',
  'bucket',
  'datauri',
  'dataurl',
  'content',
  'upload',
  'href',
] as const;

/** True when a key names a document / byte carrier (the profile word itself is not a file). */
export function isDocumentKey(key: string): boolean {
  const n = normalizeIngestKey(key);
  if (n.length === 0) return false;
  const withoutProfile = n.replace(/profile/g, '');
  if (DOCUMENT_KEY_FRAGMENTS.some((f) => withoutProfile.includes(f))) return true;
  return /(url|urls|uri|uris)$/.test(n);
}

/** True when a key names Class C (never-admitted) data. */
export function isClassCKey(key: string): boolean {
  const n = normalizeIngestKey(key);
  if (n.length === 0) return false;
  if ((CLASS_C_EXACT_KEYS as readonly string[]).includes(n)) return true;
  return CLASS_C_KEY_FRAGMENTS.some((f) => n.includes(f));
}

// ── string value classification ──────────────────────────────────────────────

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PRESIGNED_MARKERS = [
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
  'googleaccessid',
];
const LONG_BLOB = /^[A-Za-z0-9+/_=-]{256,}$/;

/** A string value that carries a document or a pointer to one. */
function documentValueReason(value: string): string | null {
  const v = value.trim();
  if (/^data:/i.test(v)) return 'data URI';
  if (/^(s3|gs|az|wasbs?|abfss?|file|ftp):/i.test(v)) return 'storage / file URI';
  const lower = v.toLowerCase();
  if (PRESIGNED_MARKERS.some((m) => lower.includes(m))) return 'presigned URL signature';
  if (/[?&]sig=/.test(lower) && /[?&](se|sv)=/.test(lower)) return 'presigned URL signature';
  if (LONG_BLOB.test(v)) return 'binary / base64 blob';
  return null;
}

const DOCUMENT_EXTENSION = /\.(pdf|docx?|rtf|odt|txt|pages|png|jpe?g|gif|tiff?|heic|zip)$/i;
const STORAGE_HOST =
  /(amazonaws\.com|cloudfront\.net|blob\.core\.windows\.net|storage\.googleapis\.com|googleusercontent\.com|drive\.google\.com|docs\.google\.com|dropbox(usercontent)?\.com|sharepoint\.com|onedrive\.live\.com|1drv\.ms|box\.com|wetransfer\.com)$/i;

/** A public PROFESSIONAL profile URL — never a document or a storage location. */
function publicProfileUrlProblem(value: string): { code: 'DOCUMENT_REJECTED' | 'VALUE'; message: string } | null {
  const reason = documentValueReason(value);
  if (reason !== null) return { code: 'DOCUMENT_REJECTED', message: `public profile URL is a ${reason}` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { code: 'VALUE', message: 'public profile URL is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { code: 'VALUE', message: 'public profile URL must be http(s)' };
  }
  if (url.username !== '' || url.password !== '') {
    return { code: 'VALUE', message: 'public profile URL must not carry credentials' };
  }
  if (DOCUMENT_EXTENSION.test(url.pathname)) {
    return { code: 'DOCUMENT_REJECTED', message: 'public profile URL points at a document' };
  }
  if (STORAGE_HOST.test(url.hostname)) {
    return { code: 'DOCUMENT_REJECTED', message: 'public profile URL points at a file-storage host' };
  }
  return null;
}

// ── schema DSL ───────────────────────────────────────────────────────────────

type Field =
  | { kind: 'string'; required?: boolean; max?: number; pattern?: RegExp; oneOf?: readonly string[]; format?: StringFormat }
  | { kind: 'number'; required?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'object'; required?: boolean; fields: Record<string, Field>; check?: ObjectCheck }
  | { kind: 'array'; required?: boolean; of: Field; max: number }
  | { kind: 'profile_url'; required?: boolean }
  | { kind: 'assertions'; required?: boolean };

type StringFormat = 'datetime' | 'partial_date' | 'date_or_datetime' | 'sha256' | 'email' | 'phone';
type ObjectCheck = (value: Record<string, unknown>, path: string, ctx: Ctx) => void;

interface Ctx {
  issues: IngestValidationIssue[];
}

const str = (extra: Partial<Extract<Field, { kind: 'string' }>> = {}): Field => ({ kind: 'string', ...extra });
const req = (extra: Partial<Extract<Field, { kind: 'string' }>> = {}): Field => ({ kind: 'string', required: true, ...extra });
const bool = (required = false): Field => ({ kind: 'boolean', required });
const obj = (fields: Record<string, Field>, required = false, check?: ObjectCheck): Field => ({
  kind: 'object',
  fields,
  required,
  ...(check ? { check } : {}),
});
const arr = (of: Field, max: number, required = false): Field => ({ kind: 'array', of, max, required });

const PARTIAL = str({ format: 'partial_date', max: 10 });
const LOCATION_FIELDS: Record<string, Field> = {
  city: str({ max: 200 }),
  region: str({ max: 200 }),
  country: str({ max: 100 }),
};
const requireOneLocationKey: ObjectCheck = (value, path, ctx) => {
  if (!['city', 'region', 'country'].some((k) => typeof value[k] === 'string')) {
    issue(ctx, path, 'MISSING', 'location needs at least one of city / region / country');
  }
};

const VERIFICATION = obj(
  {
    status: req({ oneOf: IDENTIFIER_VERIFICATION_STATUSES }),
    method: str({ max: 64 }),
    source: str({ max: 64 }),
    verified_at: str({ format: 'datetime' }),
  },
  false,
  (value, path, ctx) => {
    if (value['status'] !== 'VERIFIED') return;
    for (const k of ['method', 'source', 'verified_at']) {
      if (value[k] === undefined) issue(ctx, `${path}.${k}`, 'MISSING', `${k} is required when status is VERIFIED`);
    }
  },
);

const PAYLOAD_SCHEMAS: Record<(typeof INGESTIBLE_ASSERTION_TYPES)[number], Record<string, Field>> = {
  SKILL: {
    name: req({ max: 200 }),
    years: { kind: 'number', min: 0, max: 80 },
    last_used: PARTIAL,
    proficiency: str({ max: 64 }),
  },
  WORK_HISTORY: {
    employer: req({ max: 300 }),
    title: str({ max: 300 }),
    start_date: PARTIAL,
    end_date: PARTIAL,
    is_current: bool(),
    location: obj(LOCATION_FIELDS, false, requireOneLocationKey),
    summary: str(),
    accomplishments: arr(str(), 50),
  },
  EDUCATION: {
    institution: req({ max: 300 }),
    degree: str({ max: 200 }),
    field_of_study: str({ max: 200 }),
    start_date: PARTIAL,
    end_date: PARTIAL,
    completed: bool(),
  },
  CERTIFICATION: {
    name: req({ max: 300 }),
    issuer: str({ max: 300 }),
    issued_on: PARTIAL,
    expires_on: PARTIAL,
    credential_id: str({ max: 128 }),
  },
  PROJECT: {
    name: req({ max: 300 }),
    summary: str(),
    role: str({ max: 200 }),
    start_date: PARTIAL,
    end_date: PARTIAL,
  },
  CURRENT_EMPLOYER: { name: req({ max: 300 }) },
  TITLE: { value: req({ max: 300 }) },
  LOCATION: LOCATION_FIELDS,
  PUBLIC_PROFILE_URL: { url: { kind: 'profile_url', required: true }, label: str({ max: 100 }) },
  AVAILABILITY: { status: req({ oneOf: AVAILABILITY_STATUSES }), date_available: PARTIAL },
  WORK_AUTHORIZATION: { status: req({ oneOf: WORK_AUTHORIZATION_STATUSES }), jurisdiction: str({ max: 64 }) },
  VERIFICATION_OUTCOME: {
    target: req({ oneOf: VERIFICATION_OUTCOME_TARGETS }),
    result: req({ oneOf: VERIFICATION_OUTCOME_RESULTS }),
    method: req({ max: 64 }),
    verified_at: req({ format: 'datetime' }),
  },
};

const ID = req({ max: MAX_ID, pattern: ID_PATTERN });

const INGEST_ROOT = obj(
  {
    source_system_id: req({ oneOf: SOURCE_SYSTEM_IDS }),
    source_tenant_id: ID,
    external_talent_id: ID,
    source_event_id: ID,
    occurred_at: req({ format: 'datetime' }),
    identity: obj(
      {
        names: obj({ first: str({ max: 200 }), last: str({ max: 200 }), aliases: arr(str({ max: 200 }), 20) }),
        emails: arr(
          obj({ value: req({ format: 'email', max: 320 }), is_primary: bool(true), verification: VERIFICATION }, true),
          20,
        ),
        phones: arr(
          obj({ value: req({ format: 'phone', max: 40 }), is_primary: bool(true), verification: VERIFICATION }, true),
          20,
        ),
        government_ids: arr(
          obj(
            {
              value: req({ max: 64 }),
              jurisdiction: req({ max: 16, pattern: /^[A-Za-z0-9-]+$/ }),
              identifier_class: req({ max: 32, pattern: /^[A-Za-z0-9_]+$/ }),
              verification: VERIFICATION,
            },
            true,
          ),
          5,
        ),
      },
      true,
    ),
    assertions: { kind: 'assertions', required: true },
  },
  true,
);

const ERASED_ROOT = obj(
  {
    source_system_id: req({ oneOf: SOURCE_SYSTEM_IDS }),
    source_tenant_id: ID,
    external_talent_id: ID,
    source_event_id: ID,
    occurred_at: req({ format: 'datetime' }),
  },
  true,
);

const ASSERTION_FIELDS_EXCEPT_PAYLOAD: Record<string, Field> = {
  assertion_type: req({ max: 64 }),
  source_kind: req({ oneOf: INGEST_SOURCE_KINDS }),
  observed_at: req({ format: 'datetime' }),
  valid_from: str({ format: 'date_or_datetime' }),
  valid_to: str({ format: 'date_or_datetime' }),
  ai_derived: bool(),
  provenance: obj({ source_document_hash: req({ format: 'sha256' }) }),
};

// ── walker ───────────────────────────────────────────────────────────────────

function issue(ctx: Ctx, path: string, code: IngestValidationIssue['code'], message: string): void {
  ctx.issues.push({ path, code, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Classify a key that is NOT part of the closed schema at its position. */
function refuseUnknownKey(ctx: Ctx, path: string, key: string): void {
  if (isDocumentKey(key)) issue(ctx, path, 'DOCUMENT_REJECTED', `document field '${key}' is never admitted`);
  else if (isClassCKey(key)) issue(ctx, path, 'CLASS_C_REJECTED', `Class C field '${key}' is never admitted`);
  else issue(ctx, path, 'UNKNOWN_KEY', `unknown field '${key}'`);
}

/** Deep-scan a subtree that is already refused, so a nested document / Class C key upgrades the refusal. */
function scanRefusedSubtree(value: unknown, path: string, ctx: Ctx, depth = 0): void {
  if (depth > 32) return;
  if (typeof value === 'string') {
    const reason = documentValueReason(value);
    if (reason !== null || URL_SCHEME.test(value.trim())) {
      issue(ctx, path, 'DOCUMENT_REJECTED', `value is a ${reason ?? 'URL'}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanRefusedSubtree(v, `${path}[${i}]`, ctx, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = childPath(path, k);
      if (isDocumentKey(k)) issue(ctx, p, 'DOCUMENT_REJECTED', `document field '${k}' is never admitted`);
      else if (isClassCKey(k)) issue(ctx, p, 'CLASS_C_REJECTED', `Class C field '${k}' is never admitted`);
      scanRefusedSubtree(v, p, ctx, depth + 1);
    }
  }
}

function checkString(value: string, field: Extract<Field, { kind: 'string' }>, path: string, ctx: Ctx): void {
  const reason = documentValueReason(value);
  if (reason !== null) {
    issue(ctx, path, 'DOCUMENT_REJECTED', `value is a ${reason}`);
    return;
  }
  if (URL_SCHEME.test(value.trim())) {
    issue(ctx, path, 'DOCUMENT_REJECTED', 'URLs are admitted only as a PUBLIC_PROFILE_URL');
    return;
  }
  if (value.trim().length === 0) {
    issue(ctx, path, 'VALUE', 'must not be blank');
    return;
  }
  if (value.length > (field.max ?? MAX_STRING)) {
    issue(ctx, path, 'VALUE', `longer than ${field.max ?? MAX_STRING} characters`);
    return;
  }
  if (field.oneOf && !field.oneOf.includes(value)) {
    issue(ctx, path, 'VALUE', `must be one of ${field.oneOf.join(' | ')}`);
    return;
  }
  if (field.pattern && !field.pattern.test(value)) {
    issue(ctx, path, 'VALUE', 'has an invalid format');
    return;
  }
  if (field.format && !formatOk(field.format, value)) {
    issue(ctx, path, 'VALUE', `is not a valid ${field.format}`);
  }
}

function formatOk(format: StringFormat, value: string): boolean {
  switch (format) {
    case 'datetime':
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
    case 'partial_date':
      return PARTIAL_DATE.test(value);
    case 'date_or_datetime':
      return PARTIAL_DATE.test(value) || (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)));
    case 'sha256':
      return SHA256_HEX.test(value);
    case 'email':
      return EMAIL_SHAPE.test(value.trim());
    case 'phone': {
      if (!/^[+\d\s().-]+$/.test(value.trim())) return false;
      const digits = value.replace(/\D/g, '').length;
      return digits >= 7 && digits <= 15;
    }
  }
}

function walk(value: unknown, field: Field, path: string, ctx: Ctx): void {
  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') issue(ctx, path, 'TYPE', 'must be a string');
      else checkString(value, field, path, ctx);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) issue(ctx, path, 'TYPE', 'must be a finite number');
      else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        issue(ctx, path, 'VALUE', 'is out of range');
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issue(ctx, path, 'TYPE', 'must be a boolean');
      return;
    case 'profile_url': {
      if (typeof value !== 'string') {
        issue(ctx, path, 'TYPE', 'must be a string');
        return;
      }
      if (value.length > 2048) {
        issue(ctx, path, 'VALUE', 'longer than 2048 characters');
        return;
      }
      const problem = publicProfileUrlProblem(value);
      if (problem) issue(ctx, path, problem.code, problem.message);
      return;
    }
    case 'array':
      if (!Array.isArray(value)) {
        issue(ctx, path, 'TYPE', 'must be an array');
        scanRefusedSubtree(value, path, ctx);
        return;
      }
      if (value.length > field.max) issue(ctx, path, 'VALUE', `at most ${field.max} entries`);
      value.slice(0, field.max).forEach((v, i) => walk(v, field.of, `${path}[${i}]`, ctx));
      return;
    case 'object':
      walkObject(value, field.fields, path, ctx, field.check);
      return;
    case 'assertions':
      walkAssertions(value, path, ctx);
      return;
  }
}

function walkObject(
  value: unknown,
  fields: Record<string, Field>,
  path: string,
  ctx: Ctx,
  check?: ObjectCheck,
): void {
  if (!isPlainObject(value)) {
    issue(ctx, path, 'TYPE', 'must be an object');
    scanRefusedSubtree(value, path, ctx);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const p = childPath(path, key);
    const spec = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
    if (spec === undefined) {
      refuseUnknownKey(ctx, p, key);
      scanRefusedSubtree(child, p, ctx);
      continue;
    }
    if (child === undefined || child === null) {
      if (spec.required) issue(ctx, p, 'MISSING', `'${key}' is required`);
      else if (child === null) issue(ctx, p, 'TYPE', `'${key}' must be omitted rather than null`);
      continue;
    }
    walk(child, spec, p, ctx);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.required && !(key in value)) issue(ctx, childPath(path, key), 'MISSING', `'${key}' is required`);
  }
  check?.(value, path, ctx);
}

const MAX_ASSERTIONS = 1000;

function walkAssertions(value: unknown, path: string, ctx: Ctx): void {
  if (!Array.isArray(value)) {
    issue(ctx, path, 'TYPE', 'must be an array');
    scanRefusedSubtree(value, path, ctx);
    return;
  }
  if (value.length > MAX_ASSERTIONS) issue(ctx, path, 'VALUE', `at most ${MAX_ASSERTIONS} assertions`);
  value.slice(0, MAX_ASSERTIONS).forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      issue(ctx, p, 'TYPE', 'must be an object');
      scanRefusedSubtree(item, p, ctx);
      return;
    }
    const type = item['assertion_type'];
    const known = typeof type === 'string' && (INGESTIBLE_ASSERTION_TYPES as readonly string[]).includes(type);
    const payloadFields = known ? PAYLOAD_SCHEMAS[type as keyof typeof PAYLOAD_SCHEMAS] : undefined;
    const fields: Record<string, Field> = {
      ...ASSERTION_FIELDS_EXCEPT_PAYLOAD,
      payload: payloadFields
        ? obj(payloadFields, true, type === 'LOCATION' ? requireOneLocationKey : undefined)
        : obj({}, true),
    };
    if (typeof type === 'string' && !known) {
      const tp = `${p}.assertion_type`;
      if (isDocumentKey(type)) issue(ctx, tp, 'DOCUMENT_REJECTED', `assertion type '${type}' is a document`);
      else if (isClassCKey(type)) issue(ctx, tp, 'CLASS_C_REJECTED', `assertion type '${type}' is Class C`);
      else issue(ctx, tp, 'VALUE', `unknown assertion type '${type}'`);
    }
    walkObject(item, fields, p, ctx, (a, ap, c) => {
      if (a['assertion_type'] === 'VERIFICATION_OUTCOME' && a['source_kind'] === 'RESUME_DERIVED') {
        issue(c, `${ap}.source_kind`, 'VALUE', 'a résumé cannot carry a verification outcome');
      }
    });
  });
}

function finish<T>(value: unknown, ctx: Ctx): IngestValidationResult<T> {
  if (ctx.issues.length === 0) return { ok: true, value: value as T };
  const codes = new Set(ctx.issues.map((i) => i.code));
  const code: IngestRejectionCode = codes.has('DOCUMENT_REJECTED')
    ? 'DOCUMENT_REJECTED'
    : codes.has('CLASS_C_REJECTED')
      ? 'CLASS_C_REJECTED'
      : 'INVALID_REQUEST';
  return { ok: false, code, issues: ctx.issues };
}

/** Validate an untrusted POST /v1/ingest/talent body against the closed admission schema. */
export function validateTalentIngestRequest(input: unknown): IngestValidationResult<TalentIngestRequest> {
  const ctx: Ctx = { issues: [] };
  walk(input, INGEST_ROOT, '$', ctx);
  return finish<TalentIngestRequest>(input, ctx);
}

/** Validate an untrusted POST /v1/ingest/talent/erased body. */
export function validateTalentErasedRequest(input: unknown): IngestValidationResult<TalentErasedRequest> {
  const ctx: Ctx = { issues: [] };
  walk(input, ERASED_ROOT, '$', ctx);
  return finish<TalentErasedRequest>(input, ctx);
}

/**
 * TI-1G — a work-authorization assertion is authoritative only when it is not
 * résumé-sourced and not AI-derived. The sender's label is never trusted: TI
 * computes this flag itself.
 */
export function isAuthoritativeWorkAuthorization(sourceKind: string, aiDerived: boolean): boolean {
  return sourceKind !== 'RESUME_DERIVED' && !aiDerived;
}
