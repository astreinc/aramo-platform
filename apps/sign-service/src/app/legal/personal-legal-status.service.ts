import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { IdentityRepository, TenantRepository, type TenantDto } from '@aramo/identity';
import {
  LEGAL_CLOCK,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LEGAL_DOCUMENT_TITLES,
  BUSINESS_LEGAL_DOCUMENT_KEYS,
  LegalAcceptanceService,
  PERSONAL_LEGAL_DOCUMENT_KEYS,
  effectiveLegalDocument,
  effectivePersonalLegalDocument,
  systemLegalClock,
  type LegalClock,
  type LegalDocumentVersion,
} from '@aramo/subscription';

// Aramo Sign Personal (Free) — the Personal legal documents a signed-in user still
// has to accept. A document is pending when its currently EFFECTIVE version (the
// registry in @aramo/subscription; E-5 — an approved upcoming version is never
// owed before its effective_from) has no acceptance by this user in this tenant
// for that exact version and text (sha256) — whether it was accepted at signup
// (context SIGNUP) or later in the workspace (context IN_APP). Business tenants
// accept no Personal documents.
//
// ToS v2.0 (PO 2026-11-01) — beside the Personal path, a Business path: a user of a
// non-PERSONAL tenant owes the currently EFFECTIVE Aramo Sign Terms of Service
// (BUSINESS_LEGAL_DOCUMENT_KEYS) until they accept it, and is blocked at their next
// sign-in to the workspace until then. While no Business document is effective
// (v2.0 is registered with effective_from null until release day) nothing is pending.
// For a Personal account the terms key is `sign.terms_of_service`, resolved with
// effectivePersonalLegalDocument(): the Personal Terms 1.0 apply until v2.0 is effective.
//
// Inert for sending on its own: the send path consults pendingFor() and refuses
// with legalAcceptanceRequired() while anything is pending.

export interface PendingLegalDocument {
  key: string;
  version: string;
  url: string;
  title: string;
}

export const LEGAL_ACCEPTANCE_REQUIRED_REASON = 'legal_acceptance_required';

/** The send refusal while a current Personal document is not accepted. */
export function legalAcceptanceRequired(requestId: string): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', 'Review and accept the updated terms to continue', 403, {
    requestId,
    details: { reason: LEGAL_ACCEPTANCE_REQUIRED_REASON },
  });
}

export interface AcceptItem {
  key: string;
  version: string;
}

@Injectable()
export class PersonalLegalStatusService {
  private readonly legal: readonly LegalDocumentVersion[];
  private readonly clock: LegalClock;

  constructor(
    private readonly acceptances: LegalAcceptanceService,
    private readonly tenants: TenantRepository,
    private readonly identity: IdentityRepository,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
    @Optional() @Inject(LEGAL_CLOCK) clock?: LegalClock,
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
    this.clock = clock ?? systemLegalClock;
  }

  /** The Personal documents in effect now (a key with no effective version is skipped). */
  current(now: Date = this.clock()): LegalDocumentVersion[] {
    const docs: LegalDocumentVersion[] = [];
    for (const key of PERSONAL_LEGAL_DOCUMENT_KEYS) {
      const d = effectivePersonalLegalDocument(key, this.legal, now);
      if (d !== null) docs.push(d);
    }
    return docs;
  }

  /** ToS v2.0 — the Business documents in effect now (none while v2.0 is not effective). */
  currentBusiness(now: Date = this.clock()): LegalDocumentVersion[] {
    const docs: LegalDocumentVersion[] = [];
    for (const key of BUSINESS_LEGAL_DOCUMENT_KEYS) {
      const d = effectiveLegalDocument(key, this.legal, now);
      if (d !== null) docs.push(d);
    }
    return docs;
  }

  /** The documents in effect now for a tenant kind (PERSONAL, else the Business path). */
  private currentFor(kind: string, now: Date): LegalDocumentVersion[] {
    return kind === 'PERSONAL' ? this.current(now) : this.currentBusiness(now);
  }

  /** The documents this user must still accept (Personal or Business documents by tenant kind). */
  async pending(tenant_id: string, user_id: string): Promise<PendingLegalDocument[]> {
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null) return [];
    return this.pendingFor(tenant, user_id);
  }

  /** pending() for an already-loaded tenant (the send path has it in hand). */
  async pendingFor(tenant: Pick<TenantDto, 'id' | 'kind'>, user_id: string, now: Date = this.clock()): Promise<PendingLegalDocument[]> {
    const docs = this.currentFor(tenant.kind, now);
    if (docs.length === 0) return [];
    const accepted = await this.acceptances.acceptedBy({ tenant_id: tenant.id, user_id, keys: docs.map((d) => d.key) });
    const done = new Set(accepted.map((a) => `${a.document_key}@${a.version}#${a.sha256}`));
    return docs
      .filter((d) => !done.has(`${d.key}@${d.version}#${d.sha256}`))
      .map((d) => ({ key: d.key, version: d.version, url: d.url ?? '', title: LEGAL_DOCUMENT_TITLES[d.key] }));
  }

  /**
   * Record the user's acceptance of the currently EFFECTIVE versions. Every item must
   * name a document owed by the tenant's kind (Personal, or ToS v2.0 Business) and its
   * current approved version exactly; anything
   * else refuses the whole request (nothing recorded). Idempotent per version.
   */
  async accept(
    tenant_id: string,
    user_id: string,
    items: unknown,
    origin: { ip: string | null; user_agent: string | null },
    requestId: string,
    now: Date = this.clock(),
  ): Promise<PendingLegalDocument[]> {
    const tenant = await this.tenants.findById(tenant_id);
    // ToS v2.0 — a Business user accepts the Business documents in effect; with none in
    // effect there is nothing to accept (refused, as before, for every non-PERSONAL tenant).
    if (tenant === null || (tenant.kind !== 'PERSONAL' && this.currentBusiness(now).length === 0)) {
      throw new AramoError('VALIDATION_ERROR', 'There is nothing to accept for this account', 400, {
        requestId,
        details: { reason: 'legal_acceptance_not_applicable' },
      });
    }
    const wanted = parseItems(items, requestId);
    const current = new Map(this.currentFor(tenant.kind, now).map((d) => [d.key as string, d] as const));
    const docs: LegalDocumentVersion[] = [];
    for (const it of wanted) {
      const d = current.get(it.key);
      if (d === undefined || d.version !== it.version) {
        throw new AramoError('VALIDATION_ERROR', 'These terms have changed. Reload to see the current versions.', 400, {
          requestId,
          details: { reason: 'legal_version_not_current', key: it.key },
        });
      }
      if (!docs.includes(d)) docs.push(d);
    }
    const user = await this.identity.findUserById(user_id);
    for (const document of docs) {
      await this.acceptances.recordInApp({
        document,
        tenant_id: tenant.id,
        user_id,
        subject_email: user?.email ?? null,
        ip: origin.ip,
        user_agent: origin.user_agent,
        accepted_at: now,
      });
    }
    return this.pendingFor(tenant, user_id, now);
  }
}

function parseItems(items: unknown, requestId: string): AcceptItem[] {
  const bad = () =>
    new AramoError('VALIDATION_ERROR', 'accept must list the documents and versions you accept', 400, {
      requestId,
      details: { field: 'accept' },
    });
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) throw bad();
  return items.map((i) => {
    const o = i as { key?: unknown; version?: unknown } | null;
    if (o === null || typeof o !== 'object' || typeof o.key !== 'string' || typeof o.version !== 'string' || o.key.length > 100 || o.version.length > 20) throw bad();
    return { key: o.key, version: o.version };
  });
}
