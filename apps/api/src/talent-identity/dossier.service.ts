import { Injectable } from '@nestjs/common';
import type {
  EvidenceAssertionView,
  IntelligenceEvidenceReadResponse,
  IntelligenceProfileReadResponse,
  ResolvedFactView,
  TrustStateView,
} from '@aramo/intelligence-contracts';

import { IntelligenceAccess, type IntelligenceStatus } from './intelligence-access.js';

// ATI-SEP-1 T10 WP3b — the recruiter trust dossier, re-pointed onto Talent
// Intelligence (TI owns trust; the legacy trust ledger read is retired). A
// read-only PRESENTATION of TI's tenant view of this ATS record:
//
//   GET /v1/references/ARAMO_ATS/:tenant/:record/profile   → bands, facts, statements
//   GET /v1/references/ARAMO_ATS/:tenant/:record/evidence  → contradictions + the timeline
//
// ENRICHMENT ONLY: TI not configured / tenant not entitled / TI down → the
// honest "no assessment" head (ledger_established:false) with intelligence_status
// saying why — never an error, never a gate on an ATS decision. Bands are words
// (never a number); a contact fact carries its type + verification state only
// (the value stays on the ATS record — R10 / PII-lean).

const NOT_ESTABLISHED = 'NOT_ESTABLISHED';
const CONTACT_FACTS = new Set(['EMAIL', 'PHONE']);
const EVIDENCE_PAGE_DEFAULT = 50;
const EVIDENCE_PAGE_MAX = 200;

export interface DimensionAssessment {
  band: string;
}

export interface DossierFactItem {
  fact_type: string;
  fact_key: string;
  /** Opaque resolved value (empty for contact facts — the value lives on the record). */
  value: Record<string, unknown>;
  state: string; // RESOLVED | CONTRADICTED | STALE
  verification_status: string; // DECLARED | DOCUMENT_SUPPORTED | VERIFIED
  corroborated: boolean;
}

export interface ContradictionItem {
  assertion_id: string;
  assertion_type: string;
  contributed_by: string; // REQUESTING_TENANT | OTHER_SOURCE | TALENT_INTELLIGENCE
  assertion_payload: unknown;
  observed_at: string;
}

export interface VerificationStateItem {
  anchor_kind: string; // EMAIL | PHONE
  status: string; // VERIFIED | DECLARED | DOCUMENT_SUPPORTED — never a value
  disputed: boolean;
}

export interface DossierHead {
  talent_record_id: string;
  intelligence_status: IntelligenceStatus;
  ledger_established: boolean;
  dimensions: {
    identity: DimensionAssessment;
    claims: DimensionAssessment;
    continuity: DimensionAssessment;
    eligibility: DimensionAssessment;
  };
  /** Named-thinness statements (words; no number). */
  statements: string[];
  facts: DossierFactItem[];
  contradictions: ContradictionItem[];
  verifications: VerificationStateItem[];
  has_open_dispute: boolean;
  generated_at: string | null;
}

export interface DossierEvidenceEvent {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  at: string;
}

export interface DossierEvidenceItem {
  assertion_id: string;
  assertion_type: string;
  contributed_by: string;
  source_kind: string;
  verification_status: string;
  status: string;
  assertion_payload: unknown;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  ai_derived: boolean;
  history: DossierEvidenceEvent[];
}

export interface DossierEvidencePage {
  intelligence_status: IntelligenceStatus;
  items: DossierEvidenceItem[];
  next_cursor: string | null;
}

/** TI's trust flags → plain statements (bands + words, never a count). */
export function trustStatements(t: TrustStateView): string[] {
  const out: string[] = [];
  if (t.single_source_only) out.push('All evidence comes from a single source.');
  if (t.verification_stale) out.push('A verification is due for renewal.');
  if (t.open_contradiction_count > 0) out.push('Some evidence is contradicted and needs review.');
  if (t.stale_assertion_count > 0) out.push('Some evidence is out of date.');
  if (t.has_open_dispute) out.push('The talent has an open dispute.');
  return out;
}

function toFact(f: ResolvedFactView): DossierFactItem {
  const contact = CONTACT_FACTS.has(f.fact_type);
  return {
    fact_type: f.fact_type,
    fact_key: contact ? '' : f.fact_key,
    value: contact ? {} : f.value,
    state: f.state,
    verification_status: f.verification_status,
    corroborated: f.corroborating_sources > 1,
  };
}

function toEvidenceItem(a: EvidenceAssertionView): DossierEvidenceItem {
  return {
    assertion_id: a.assertion_id,
    assertion_type: a.assertion_type,
    contributed_by: a.contributed_by,
    source_kind: a.source_kind,
    verification_status: a.verification_status,
    status: a.status,
    assertion_payload: a.payload,
    observed_at: a.observed_at,
    valid_from: a.valid_from,
    valid_to: a.valid_to,
    ai_derived: a.ai_derived,
    history: a.history.map((h) => ({ event_type: h.event_type, from_status: h.from_status, to_status: h.to_status, at: h.at })),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^o:(\d{1,7})$/.exec(raw);
  return m === null ? 0 : Number(m[1]);
}

@Injectable()
export class DossierService {
  constructor(private readonly ti: IntelligenceAccess) {}

  private emptyHead(recordId: string, status: IntelligenceStatus): DossierHead {
    const nil: DimensionAssessment = { band: NOT_ESTABLISHED };
    return {
      talent_record_id: recordId,
      intelligence_status: status,
      ledger_established: false,
      dimensions: { identity: nil, claims: nil, continuity: nil, eligibility: nil },
      statements: [],
      facts: [],
      contradictions: [],
      verifications: [],
      has_open_dispute: false,
      generated_at: null,
    };
  }

  /** The raw TI profile read (fail-soft) — shared with the Talent 360 identity outcomes. */
  readProfile(tenant_id: string, recordId: string) {
    return this.ti.read<IntelligenceProfileReadResponse>(tenant_id, (c) => c.readProfile({ tenant_id, talent_id: recordId }));
  }

  private readEvidence(tenant_id: string, recordId: string) {
    return this.ti.read<IntelligenceEvidenceReadResponse>(tenant_id, (c) => c.readEvidence({ tenant_id, talent_id: recordId }));
  }

  async getDossier(tenant_id: string, recordId: string): Promise<DossierHead> {
    const profile = await this.readProfile(tenant_id, recordId);
    if (profile.value === null) return this.emptyHead(recordId, profile.status);
    const p = profile.value;
    // Contradictions + the disputed flags need the evidence view (best-effort: a
    // failed second read degrades to no contradiction items, never an error).
    const evidence = await this.readEvidence(tenant_id, recordId);
    const assertions = evidence.value?.assertions ?? [];
    const disputed = new Set(assertions.filter((a) => a.status === 'DISPUTED').map((a) => a.assertion_id));

    const band = (b: string | undefined): DimensionAssessment => ({ band: b ?? NOT_ESTABLISHED });
    return {
      talent_record_id: recordId,
      intelligence_status: 'ENABLED',
      ledger_established: true,
      dimensions: {
        identity: band(p.trust.identity_band),
        claims: band(p.trust.claims_band),
        continuity: band(p.trust.continuity_band),
        eligibility: band(p.trust.eligibility_band),
      },
      statements: trustStatements(p.trust),
      facts: p.facts.map(toFact),
      contradictions: assertions
        .filter((a) => a.status === 'CONTRADICTED')
        .map((a) => ({
          assertion_id: a.assertion_id,
          assertion_type: a.assertion_type,
          contributed_by: a.contributed_by,
          assertion_payload: a.payload,
          observed_at: a.observed_at,
        })),
      verifications: p.facts
        .filter((f) => CONTACT_FACTS.has(f.fact_type))
        .map((f) => ({
          anchor_kind: f.fact_type,
          status: f.verification_status,
          // A contact is disputed when an assertion backing it (its TI verification
          // outcome) is DISPUTED in the tenant view.
          disputed: f.supporting_assertion_ids.some((id) => disputed.has(id)),
        })),
      has_open_dispute: p.trust.has_open_dispute,
      generated_at: p.generated_at,
    };
  }

  async getDossierEvidence(
    tenant_id: string,
    recordId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<DossierEvidencePage> {
    const limit = Math.min(Math.max(opts.limit ?? EVIDENCE_PAGE_DEFAULT, 1), EVIDENCE_PAGE_MAX);
    const evidence = await this.readEvidence(tenant_id, recordId);
    if (evidence.value === null) return { intelligence_status: evidence.status, items: [], next_cursor: null };
    // Newest observation first; TI returns the full tenant view, paged here.
    const all = [...evidence.value.assertions].sort((a, b) =>
      a.observed_at === b.observed_at ? (a.assertion_id < b.assertion_id ? 1 : -1) : a.observed_at < b.observed_at ? 1 : -1,
    );
    const offset = decodeCursor(opts.cursor);
    const page = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? encodeCursor(offset + limit) : null;
    return { intelligence_status: 'ENABLED', items: page.map(toEvidenceItem), next_cursor: next };
  }
}
