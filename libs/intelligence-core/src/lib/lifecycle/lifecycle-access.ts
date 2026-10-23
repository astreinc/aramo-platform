import {
  LIFECYCLE_PAGE_DEFAULT_LIMIT,
  LIFECYCLE_PAGE_MAX_LIMIT,
  type LifecycleRefusalCode,
  type TalentReferenceTuple,
} from '@aramo/intelligence-contracts';

import { survivingSubject } from '../identity/identity-resolution.service.js';
import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import type {
  ExternalTalentReference,
  GoldenTalent,
  IntelligenceRepositories,
  PageCursor,
  SourceTuple,
  TenantKey,
} from '../repositories/types.js';

// ATI-SEP-1 T10 — the access gates shared by the evidence-lifecycle services
// (ADR-0036 §6). Knowledge of a subject id grants nothing:
//   * a tenant acts only for its own source system, only while it holds the
//     `intelligence` capability (EntitledTenant ACTIVE → else 403 NOT_ENTITLED),
//     and only on subjects where it holds an ACTIVE reference (else 404);
//   * the portal (talent) side addresses its subject through a reference tuple
//     the talent holds; a talent's data rights do not depend on the tenant's
//     subscription, so it needs no entitlement.

export class LifecycleRefusedError extends Error {
  constructor(
    readonly code: LifecycleRefusalCode,
    readonly details: { issues?: string[] } = {},
  ) {
    super(`refused: ${code}`);
    this.name = 'LifecycleRefusedError';
  }
}

export const refused = (code: LifecycleRefusalCode, issues?: string[]): LifecycleRefusedError =>
  new LifecycleRefusedError(code, issues ? { issues } : {});

export async function requireEntitledTenant(repos: IntelligenceRepositories, principal: IngestPrincipal, tenant: TenantKey): Promise<void> {
  if (principal.source_system_id !== tenant.source_system_id) throw refused('SOURCE_SYSTEM_MISMATCH');
  const entitled = await repos.entitlements.find(tenant.source_system_id, tenant.source_tenant_id);
  if (entitled === null || !entitled.active) throw refused('NOT_ENTITLED');
}

/** The ACTIVE reference and its surviving, readable subject — else 404 REFERENCE_NOT_FOUND. */
export async function requireActiveReference(
  repos: IntelligenceRepositories,
  principal: IngestPrincipal,
  tuple: SourceTuple | TalentReferenceTuple,
  opts: { entitled: boolean },
): Promise<{ reference: ExternalTalentReference; subject: GoldenTalent }> {
  if (opts.entitled) await requireEntitledTenant(repos, principal, tuple);
  else if (principal.source_system_id !== tuple.source_system_id) throw refused('SOURCE_SYSTEM_MISMATCH');
  const reference = await repos.references.findByTuple(tuple);
  if (reference === null || reference.status !== 'ACTIVE') throw refused('REFERENCE_NOT_FOUND');
  const subject = await survivingSubject(repos, reference.subject_id);
  if (subject.access_state !== 'ACTIVE' || subject.resolution_status === 'MERGED') throw refused('REFERENCE_NOT_FOUND');
  return { reference, subject };
}

/** The tenant's ACTIVE references on a subject (the tenant's own talent ids). */
export async function tenantReferencesOn(repos: IntelligenceRepositories, subjectId: string, tenant: TenantKey): Promise<ExternalTalentReference[]> {
  return (await repos.references.listBySubject(subjectId)).filter(
    (r) => r.status === 'ACTIVE' && r.source_system_id === tenant.source_system_id && r.source_tenant_id === tenant.source_tenant_id,
  );
}

/** The audit actor of a tenant action: the tenant is part of the record (enrichment decision of THAT tenant). */
export const tenantActor = (tenant: TenantKey, actor: string): string => `tenant:${tenant.source_system_id}:${tenant.source_tenant_id}:${actor}`;

export function encodeCursor(c: PageCursor): string {
  return Buffer.from(`${c.at.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): PageCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200) throw refused('INVALID_REQUEST', ['cursor: invalid']);
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) throw refused('INVALID_REQUEST', ['cursor: invalid']);
  return { at: date, id: id as string };
}

export function pageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return LIFECYCLE_PAGE_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw refused('INVALID_REQUEST', ['limit: a positive integer']);
  return Math.min(n, LIFECYCLE_PAGE_MAX_LIMIT);
}
