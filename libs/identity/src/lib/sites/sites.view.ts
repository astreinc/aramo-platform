import { AramoError } from '@aramo/common';

// Settings Rebuild Directive 4 — sites/branches shapes + input validation.
//
// Validation is hand-rolled (the D3 precedent) so every bad input is a 400
// VALIDATION_ERROR with a precise details.reason — never a 500. The deeper,
// DB-dependent parent checks (exists / same-tenant / active / no-self / no-
// cycle / depth) live in SitesService; this module covers the pure-input
// shape (types, lengths, UUID format, unknown-field rejection).

// The editable site fields, in a single source of truth shared by the PATCH
// whitelist, the create whitelist, and the audit changed-field naming.
export const SITE_FIELDS = ['name', 'parent_site_id'] as const;
export type SiteField = (typeof SITE_FIELDS)[number];

export const SITE_NAME_MAX = 200;

// Soft cap on branch nesting depth (root = depth 1). Mirrors the FE org-tree
// soft cap; a defensive bound so a pathological deep chain can't be created.
export const MAX_SITE_DEPTH = 10;

export interface SiteView {
  readonly id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly parent_site_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SiteRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly parent_site_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateSiteInput {
  readonly name: string;
  readonly parent_site_id: string | null;
}

// A validated PATCH: only the keys actually present in the body appear, so the
// service can distinguish "leave unchanged" (absent) from "clear" (null).
export interface UpdateSitePatch {
  name?: string;
  parent_site_id?: string | null;
}

// Accepts the canonical 8-4-4-4-12 hex UUID (any version). Sites use UUID v7
// ids; the format check only needs to reject obvious non-UUID input → 400.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toView(row: SiteRow): SiteView {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active,
    parent_site_id: row.parent_site_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Validates a create body. `name` is required (non-empty, bounded);
// `parent_site_id` is optional (absent or null → root branch).
export function validateCreate(
  body: Record<string, unknown>,
  requestId: string,
): CreateSiteInput {
  rejectUnknownFields(body, requestId);
  if (!('name' in body)) {
    throw bad('name is required', requestId, { reason: 'name_required', field: 'name' });
  }
  const name = validateName(body['name'], requestId);
  const parent_site_id =
    'parent_site_id' in body
      ? validateParentId(body['parent_site_id'], requestId)
      : null;
  return { name, parent_site_id };
}

// Validates an update body. Every field is optional; an absent field is left
// unchanged. An empty body is a valid no-op (the service short-circuits it).
export function validateUpdate(
  body: Record<string, unknown>,
  requestId: string,
): UpdateSitePatch {
  rejectUnknownFields(body, requestId);
  const patch: UpdateSitePatch = {};
  if ('name' in body) patch.name = validateName(body['name'], requestId);
  if ('parent_site_id' in body) {
    patch.parent_site_id = validateParentId(body['parent_site_id'], requestId);
  }
  return patch;
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  requestId: string,
): void {
  const allowed = new Set<string>(SITE_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw bad(`unknown site field '${key}'`, requestId, {
        reason: 'unknown_field',
        field: key,
        allowed: [...SITE_FIELDS],
      });
    }
  }
}

function validateName(raw: unknown, requestId: string): string {
  if (typeof raw !== 'string') {
    throw bad('name must be a string', requestId, {
      reason: 'invalid_type',
      field: 'name',
    });
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw bad('name must not be empty', requestId, {
      reason: 'name_required',
      field: 'name',
    });
  }
  if (value.length > SITE_NAME_MAX) {
    throw bad(`name exceeds ${SITE_NAME_MAX} characters`, requestId, {
      reason: 'too_long',
      field: 'name',
      max: SITE_NAME_MAX,
    });
  }
  return value;
}

// null → root (or clear the parent); a string must be UUID-shaped. The
// existence / same-tenant / active / cycle checks are the service's job.
function validateParentId(raw: unknown, requestId: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw bad('parent_site_id must be a UUID or null', requestId, {
      reason: 'invalid_type',
      field: 'parent_site_id',
    });
  }
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!UUID_RE.test(value)) {
    throw bad('parent_site_id is not a valid UUID', requestId, {
      reason: 'invalid_parent_id',
      field: 'parent_site_id',
    });
  }
  return value;
}

function bad(
  message: string,
  requestId: string,
  details: Record<string, unknown>,
): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details });
}
