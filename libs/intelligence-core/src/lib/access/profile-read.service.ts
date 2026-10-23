import { Inject, Injectable } from '@nestjs/common';
import type {
  Contributor,
  EvidenceAssertionView,
  IntelligenceArtifactsReadResponse,
  IntelligenceEvidenceReadResponse,
  IntelligenceProfileReadResponse,
  ReadAccessMode,
  ReadRefusalCode,
  ResolvedFactView,
  TrustStateView,
} from '@aramo/intelligence-contracts';

import { survivingSubject } from '../identity/identity-resolution.service.js';
import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import { availabilityFreshnessDays, artifactSupportedIds, toProjectionAssertion, toProjectionIdentifier } from '../projection/projection.service.js';
import { computeProjection, orderFacts, type ProjectionResult } from '../projection/projection.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type Assertion,
  type ExternalTalentReference,
  type GoldenTalent,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type SourceTuple,
  type SubjectIdentifier,
  type TrustStateRow,
} from '../repositories/types.js';
import { RETIRED_ASSERTION_STATUSES, type ReadKind, type ReadOutcome } from '../vocabulary.js';

import { crossTenantReadEnabled, reconciledPairs, tenantViewAssertions, tenantViewIdentifiers } from './tenant-view.js';

// ATI-SEP-1 T6 (ADR-0036 §6, Addendum A1) — the tenant read API.
//
// A tenant reads a subject ONLY through its own reference tuple, and only when
//   (a) the service principal's source system is the tuple's source system,
//   (b) EntitledTenant(source_system_id, source_tenant_id) is ACTIVE
//       (TI does not know ATS entitlements; the ATS syncs them),
//   (c) the exact ExternalTalentReference exists and is ACTIVE (ERASED → 404),
//   (d) the surviving subject's access_state is ACTIVE (AUDIT_RETAINED → 404).
// Knowledge of a subject id grants nothing: there is no by-subject route.
//
// TI_CROSS_TENANT_READ_ENABLED (default false, pending Legal L-1):
//   false → TENANT_SCOPED: the projection is computed ON THE FLY from the
//           requesting tenant's own assertions + TI-originated ones
//           (VERIFICATION / TI_ACQUIRED); contacts are the tenant's own, marked
//           verified when TI verified the same value. A contradiction raised by a
//           hidden source is not visible (statuses are recomputed in the view).
//   true  → CROSS_TENANT: the stored Golden projection (computed on the fly
//           only when it has not been built yet). Other tenants are never named:
//           contributed_by is REQUESTING_TENANT | OTHER_SOURCE | TALENT_INTELLIGENCE.
// Artifacts: only TI-acquired ones whose DocumentTypePolicy.globally_shareable
// (metadata only — never the storage key).
// Every attempt, granted or refused, is written to IntelligenceReadAudit.

export { TI_CROSS_TENANT_READ_ENABLED_ENV, crossTenantReadEnabled } from './tenant-view.js';

export class ReadRefusedError extends Error {
  constructor(readonly code: ReadRefusalCode) {
    super(`read refused: ${code}`);
    this.name = 'ReadRefusedError';
  }
}

const TI_SOURCE_KINDS = new Set(['VERIFICATION', 'TI_ACQUIRED']);

interface Granted {
  subject: GoldenTalent;
  reference: ExternalTalentReference;
}

type Tx<T> = { ok: true; value: T } | { ok: false; code: ReadRefusalCode };

interface View {
  mode: ReadAccessMode;
  /** Every assertion of the view, any status (evidence history). */
  assertions: Assertion[];
  identifiers: SubjectIdentifier[];
  projection: ProjectionResult;
}

function trustView(t: TrustStateRow): TrustStateView {
  return {
    identity_band: t.identity_band as TrustStateView['identity_band'],
    claims_band: t.claims_band as TrustStateView['claims_band'],
    continuity_band: t.continuity_band as TrustStateView['continuity_band'],
    eligibility_band: t.eligibility_band as TrustStateView['eligibility_band'],
    open_contradiction_count: t.open_contradiction_count,
    stale_assertion_count: t.stale_assertion_count,
    has_open_dispute: t.has_open_dispute,
    single_source_only: t.single_source_only,
    verification_stale: t.verification_stale,
  };
}

// TENANT_SCOPED (TI_CROSS_TENANT_READ_ENABLED=false) recomputes contradictions
// INSIDE the requesting tenant's view (effective_status above). The stored
// ledger events, however, record contradictions against the GLOBAL assertion
// set — replaying them would reveal that a hidden source disagrees. So the
// scoped history omits contradiction transitions; the view's own status
// carries any contradiction that is visible to this tenant.
function revealsHiddenContradiction(e: { event_type: string; from_status: string | null; to_status: string | null }): boolean {
  return (
    e.event_type === 'CONTRADICTED' ||
    e.event_type === 'CONTRADICTION_RESOLVED' ||
    e.from_status === 'CONTRADICTED' ||
    e.to_status === 'CONTRADICTED'
  );
}

@Injectable()
export class ProfileReadService {
  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  async profile(principal: IngestPrincipal, tuple: SourceTuple, now: Date = new Date()): Promise<IntelligenceProfileReadResponse> {
    return this.read(principal, tuple, 'PROFILE', async (repos, g, mode) => {
      if (mode === 'CROSS_TENANT') {
        const stored = await this.storedProfile(repos, g.subject.id);
        if (stored !== null) return { value: { intelligence_subject_id: g.subject.id, access_mode: mode, ...stored, generated_at: now.toISOString() }, fields: stored.facts.length };
      }
      const view = await this.view(repos, g, tuple, mode, now);
      const facts: ResolvedFactView[] = view.projection.facts.map((f) => ({
        fact_type: f.fact_type,
        fact_key: f.fact_key,
        value: f.value,
        state: f.state,
        verification_status: f.verification_status,
        corroborating_sources: f.corroborating_sources,
        supporting_assertion_ids: f.supporting_assertion_ids,
      }));
      return {
        value: { intelligence_subject_id: g.subject.id, access_mode: mode, facts, trust: trustView(view.projection.trust), generated_at: now.toISOString() },
        fields: facts.length,
      };
    });
  }

  async evidence(principal: IngestPrincipal, tuple: SourceTuple, now: Date = new Date()): Promise<IntelligenceEvidenceReadResponse> {
    return this.read(principal, tuple, 'EVIDENCE', async (repos, g, mode) => {
      const view = await this.view(repos, g, tuple, mode, now);
      const events = await repos.assertions.listEventsFor(view.assertions.map((a) => a.id));
      const byAssertion = new Map<string, typeof events>();
      for (const e of events) byAssertion.set(e.assertion_id, [...(byAssertion.get(e.assertion_id) ?? []), e]);
      const assertions: EvidenceAssertionView[] = view.assertions.map((a) => ({
        assertion_id: a.id,
        assertion_type: a.assertion_type,
        admission_class: a.admission_class as 'A' | 'B',
        payload: (a.payload ?? {}) as Record<string, unknown>,
        contributed_by: this.contributor(a, tuple),
        source_kind: a.source_kind,
        verification_status: a.verification_status,
        status: view.projection.effective_status.get(a.id) ?? a.current_status,
        observed_at: a.observed_at.toISOString(),
        valid_from: a.valid_from?.toISOString() ?? null,
        valid_to: a.valid_to?.toISOString() ?? null,
        ai_derived: a.ai_derived,
        source_document_hash: a.source_document_hash,
        history: (byAssertion.get(a.id) ?? []).filter((e) => mode === 'CROSS_TENANT' || !revealsHiddenContradiction(e)).map((e) => ({
          event_type: e.event_type,
          from_status: e.from_status,
          to_status: e.to_status,
          at: e.created_at.toISOString(),
        })),
      }));
      return {
        value: { intelligence_subject_id: g.subject.id, access_mode: mode, assertions, generated_at: now.toISOString() },
        fields: assertions.length,
      };
    });
  }

  async artifacts(principal: IngestPrincipal, tuple: SourceTuple, now: Date = new Date()): Promise<IntelligenceArtifactsReadResponse> {
    return this.read(principal, tuple, 'ARTIFACTS', async (repos, g, mode) => {
      const visible = new Set((await this.viewAssertions(repos, g.subject.id, tuple, mode)).map((a) => a.id));
      const all = await repos.artifacts.listBySubject(g.subject.id);
      const shareable = [];
      for (const art of all) {
        const policy = await repos.artifacts.findPolicy(art.document_type);
        if (policy?.globally_shareable === true) shareable.push(art);
      }
      const supports = await repos.artifacts.listSupports(shareable.map((a) => a.id));
      const artifacts = shareable.map((a) => ({
        artifact_id: a.id,
        document_type: a.document_type,
        issuer: a.issuer,
        sha256: a.sha256,
        retrieved_at: a.retrieved_at.toISOString(),
        supports_assertion_ids: supports
          .filter((s) => s.artifact_id === a.id && visible.has(s.assertion_id))
          .map((s) => s.assertion_id)
          .sort(),
      }));
      return { value: { intelligence_subject_id: g.subject.id, access_mode: mode, artifacts, generated_at: now.toISOString() }, fields: artifacts.length };
    });
  }

  // ── authorization + audit ──────────────────────────────────────────────────

  private async read<T>(
    principal: IngestPrincipal,
    tuple: SourceTuple,
    kind: ReadKind,
    build: (repos: IntelligenceRepositories, g: Granted, mode: ReadAccessMode) => Promise<{ value: T; fields: number }>,
  ): Promise<T> {
    const mode: ReadAccessMode = crossTenantReadEnabled() ? 'CROSS_TENANT' : 'TENANT_SCOPED';
    // The audit row commits with the outcome, so a refusal is returned (not thrown) from the unit of work.
    const tx = await this.uow.run<Tx<T>>(async (repos) => {
      const audit = (outcome: ReadOutcome, extra: { reference_id?: string; subject_id?: string; fields?: number; mode?: ReadAccessMode } = {}) =>
        repos.readAudit.create({
          client_id: principal.client_id,
          ...tuple,
          read_kind: kind,
          outcome,
          access_mode: extra.mode ?? null,
          reference_id: extra.reference_id ?? null,
          subject_id: extra.subject_id ?? null,
          fields_returned: extra.fields ?? 0,
        });
      const refuse = async (code: ReadRefusalCode, extra: { reference_id?: string; subject_id?: string } = {}): Promise<Tx<T>> => {
        await audit(code, extra);
        return { ok: false, code };
      };

      if (principal.source_system_id !== tuple.source_system_id) return refuse('SOURCE_SYSTEM_MISMATCH');
      const entitled = await repos.entitlements.find(tuple.source_system_id, tuple.source_tenant_id);
      if (entitled === null || !entitled.active) return refuse('NOT_ENTITLED');
      const reference = await repos.references.findByTuple(tuple);
      if (reference === null || reference.status !== 'ACTIVE') {
        return refuse('REFERENCE_NOT_FOUND', reference ? { reference_id: reference.id } : {});
      }
      const subject = await survivingSubject(repos, reference.subject_id);
      if (subject.access_state !== 'ACTIVE' || subject.resolution_status === 'MERGED') {
        return refuse('REFERENCE_NOT_FOUND', { reference_id: reference.id, subject_id: subject.id });
      }
      const built = await build(repos, { subject, reference }, mode);
      await audit('GRANTED', { reference_id: reference.id, subject_id: subject.id, fields: built.fields, mode });
      return { ok: true, value: built.value };
    });
    if (!tx.ok) throw new ReadRefusedError(tx.code);
    return tx.value;
  }

  // ── views ──────────────────────────────────────────────────────────────────

  private own(a: Assertion, tuple: SourceTuple): boolean {
    return a.source_system_id === tuple.source_system_id && a.source_tenant_id === tuple.source_tenant_id;
  }

  private contributor(a: Assertion, tuple: SourceTuple): Contributor {
    if (this.own(a, tuple)) return 'REQUESTING_TENANT';
    if (TI_SOURCE_KINDS.has(a.source_kind)) return 'TALENT_INTELLIGENCE';
    return 'OTHER_SOURCE';
  }

  private async viewAssertions(repos: IntelligenceRepositories, subjectId: string, tuple: SourceTuple, mode: ReadAccessMode): Promise<Assertion[]> {
    return tenantViewAssertions(await repos.assertions.listBySubject(subjectId), tuple, mode === 'CROSS_TENANT');
  }

  private async viewIdentifiers(repos: IntelligenceRepositories, g: Granted, tuple: SourceTuple, mode: ReadAccessMode): Promise<SubjectIdentifier[]> {
    const all = await repos.identifiers.listBySubject(g.subject.id);
    return tenantViewIdentifiers(all, await repos.references.listBySubject(g.subject.id), tuple, mode === 'CROSS_TENANT');
  }

  private async view(repos: IntelligenceRepositories, g: Granted, tuple: SourceTuple, mode: ReadAccessMode, now: Date): Promise<View> {
    const assertions = await this.viewAssertions(repos, g.subject.id, tuple, mode);
    const identifiers = await this.viewIdentifiers(repos, g, tuple, mode);
    const live = assertions.filter((a) => !(RETIRED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status));
    const projection = computeProjection(live.map(toProjectionAssertion), identifiers.map(toProjectionIdentifier), {
      now,
      availabilityFreshnessDays: availabilityFreshnessDays(),
      artifactSupported: await artifactSupportedIds(repos, g.subject.id),
      reconciled: reconciledPairs(await repos.assertions.listLinksFor(live.map((a) => a.id))),
    });
    return { mode, assertions, identifiers, projection };
  }

  /** The persisted Golden projection (CROSS_TENANT), or null when it has not been built yet. */
  private async storedProfile(
    repos: IntelligenceRepositories,
    subjectId: string,
  ): Promise<{ facts: ResolvedFactView[]; trust: TrustStateView } | null> {
    const trust = await repos.trust.find(subjectId);
    if (trust === null) return null;
    const rows = await repos.facts.listBySubject(subjectId);
    const facts = rows.map((r) => {
      const v = (r.value ?? {}) as { value?: Record<string, unknown>; state?: string; verification_status?: string; corroborating_sources?: number };
      return {
        fact_type: r.fact_type as ResolvedFactView['fact_type'],
        fact_key: r.fact_key,
        value: v.value ?? {},
        state: (v.state ?? 'RESOLVED') as ResolvedFactView['state'],
        verification_status: (v.verification_status ?? 'DECLARED') as ResolvedFactView['verification_status'],
        corroborating_sources: v.corroborating_sources ?? 1,
        supporting_assertion_ids: [...r.supporting_assertion_ids].sort(),
      };
    });
    return { facts: orderFacts(facts), trust: trustView(trust) };
  }
}
