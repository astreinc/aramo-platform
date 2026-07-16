import { Injectable } from '@nestjs/common';
import {
  deriveTrustStatements,
  TalentTrustService,
  TalentTrustRepository,
  type EvidenceRecordRow,
  type EvidenceLinkRow,
} from '@aramo/talent-trust';

// TR-14 B2 (DDR §2.1/§2.5) — the trust dossier assembler: the Trust Assessment
// form as a contracted, read-only surface per TalentRecord. apps/api orchestration
// above the I15 wall (the sourcing precedent) — resolves the ATS_TALENT_RECORD ref
// to its ACTIVE-fixpoint subject, reads the CLUSTER-UNION, and PRESENTS the ledger:
// bands + statements, contradictions as items (never counts), verification state,
// merge provenance, advisory pointers. NEVER computes (DDR §1) — deriveTrustStatements
// is the pre-built TR-5 renderer; everything else is a read.
//
// A record with no subject (the honest add-talent edge) returns the uniform
// ledger_established:false shape, never an error.

const CONTACT_ANCHOR_KINDS = ['EMAIL', 'PHONE', 'PROFILE_URL'] as const;
const NOT_ESTABLISHED = 'NOT_ESTABLISHED';

// The dossier evidence row — strength-stripped, exactly as the sourcing wire (B1).
export type DossierEvidenceRow = Omit<EvidenceRecordRow, 'strength'>;

export interface DimensionAssessment {
  band: string;
}
export interface ContradictionItem {
  evidence_id: string;
  dimension: string;
  assertion_type: string;
  reason: string | null;
  contradicting_evidence_id: string | null;
  // The contradicted evidence's claim facts (ledger-visible; never a trust ordinal).
  assertion_payload: unknown;
}
export interface VerificationStateItem {
  anchor_kind: string;
  status: string; // PENDING | CONFIRMED | EXPIRED | NONE — never a value (PII)
  // Portal P3b (ruling 4 / Q1) — DERIVED from the anchor's backing EvidenceRecord
  // being current_status === 'DISPUTED'; never a parallel-stored field. While an
  // item is disputed, any tenant-facing consumption of it surfaces this here.
  disputed: boolean;
}
export interface MergeProvenanceItem {
  operation_id: string;
  kind: string;
  role: 'survivor' | 'merged';
  completed_at: string | null;
}
export interface DossierHead {
  talent_record_id: string;
  ledger_established: boolean;
  dimensions: {
    identity: DimensionAssessment;
    claims: DimensionAssessment;
    continuity: DimensionAssessment;
    eligibility: DimensionAssessment;
  };
  // GLOBAL named-thinness statements (the TR-5 renderer is global, not per-dimension;
  // DDR §1 forbids inventing per-dimension statements). Strings only — no number.
  statements: string[];
  contradictions: ContradictionItem[];
  verifications: VerificationStateItem[];
  merge_provenance: MergeProvenanceItem[];
  // Pointers (ids) toward the TR-6 worklist — NO advisory data duplicated.
  advisory_pointers: string[];
  // TR-12 B2 (§3.3) — pointers (id + kind) toward the caseworker's Trust Proposals
  // queue; OPEN proposals only. Kinds are words (R10 — no number). NO proposal data
  // beyond the pointer is duplicated here (the queue is the source of truth).
  proposal_pointers: ProposalPointerItem[];
}

export interface ProposalPointerItem {
  id: string;
  kind: string;
}

export interface DossierEvidenceItem {
  event: {
    id: string;
    event_type: string;
    actor: string | null;
    reason: string | null;
    linked_evidence_id: string | null;
    occurred_at: string;
  };
  evidence: DossierEvidenceRow;
  links: EvidenceLinkRow[];
}
export interface DossierEvidencePage {
  items: DossierEvidenceItem[];
  next_cursor: string | null;
}

const stripStrength = (e: EvidenceRecordRow): DossierEvidenceRow => {
  const { strength: _strength, ...rest } = e;
  return rest;
};

function encodeCursor(occurred_at: Date, id: string): string {
  return Buffer.from(`${occurred_at.toISOString()}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | null): { occurred_at: Date; id: string } | null {
  if (cursor === null || cursor === '') return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.lastIndexOf('|');
  if (sep < 0) return null;
  const occurred_at = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(occurred_at.getTime()) || id === '') return null;
  return { occurred_at, id };
}

@Injectable()
export class DossierService {
  constructor(
    private readonly trust: TalentTrustService,
    private readonly repo: TalentTrustRepository,
  ) {}

  private ref(tenant_id: string, recordId: string) {
    return { tenant_id, ref_type: 'ATS_TALENT_RECORD' as const, ref_id: recordId };
  }

  private emptyHead(recordId: string): DossierHead {
    const nil: DimensionAssessment = { band: NOT_ESTABLISHED };
    return {
      talent_record_id: recordId,
      ledger_established: false,
      dimensions: { identity: nil, claims: nil, continuity: nil, eligibility: nil },
      statements: [],
      contradictions: [],
      verifications: [],
      merge_provenance: [],
      advisory_pointers: [],
      proposal_pointers: [],
    };
  }

  async getDossier(tenant_id: string, recordId: string): Promise<DossierHead> {
    const subject = await this.trust.resolveSubjectRef(this.ref(tenant_id, recordId));
    if (subject === null) return this.emptyHead(recordId);

    const members = await this.repo.clusterMembers(subject.id);
    const [trustState, evidence, advisories, mergeOps, proposals] = await Promise.all([
      this.repo.findTrustStateBySubject(subject.id),
      this.repo.listEvidenceBySubjects(members),
      this.repo.listMatchAdvisories(tenant_id, { subjectId: subject.id }),
      this.repo.listCompletedMergeOperationsForSubject(tenant_id, subject.id),
      // TR-12 B2 — OPEN proposals for this subject (the pointer line to the queue).
      this.repo.listProposalsForSubject(tenant_id, subject.id, { status: 'OPEN' }),
    ]);

    const evidenceIds = evidence.map((e) => e.id);
    // Ruling 4 — the DISPUTED evidence set, derived from the already-loaded
    // cluster evidence; the per-item disputed flag reads from it (no extra query).
    const disputedEvidenceIds = new Set(
      evidence.filter((e) => e.current_status === 'DISPUTED').map((e) => e.id),
    );
    const [links, contradictionEvents, verifications] = await Promise.all([
      this.repo.listEvidenceLinksForEvidence(evidenceIds),
      this.repo.listEventsForEvidence(
        evidence.filter((e) => e.current_status === 'CONTRADICTED').map((e) => e.id),
        'CONTRADICTED',
      ),
      this.assembleVerifications(tenant_id, members, disputedEvidenceIds),
    ]);

    // Latest CONTRADICTED event per evidence (events are newest-first).
    const reasonBy = new Map<string, { reason: string | null; linked: string | null }>();
    for (const ev of contradictionEvents) {
      if (!reasonBy.has(ev.evidence_id)) {
        reasonBy.set(ev.evidence_id, { reason: ev.reason, linked: ev.linked_evidence_id });
      }
    }
    const linkPartner = (evidenceId: string): string | null => {
      const l = links.find(
        (x) => x.relation === 'CONTRADICTS' && (x.from_evidence_id === evidenceId || x.to_evidence_id === evidenceId),
      );
      if (l === undefined) return null;
      return l.from_evidence_id === evidenceId ? l.to_evidence_id : l.from_evidence_id;
    };
    const contradictions: ContradictionItem[] = evidence
      .filter((e) => e.current_status === 'CONTRADICTED')
      .map((e) => {
        const evt = reasonBy.get(e.id);
        return {
          evidence_id: e.id,
          dimension: e.dimension,
          assertion_type: e.assertion_type,
          reason: evt?.reason ?? null,
          contradicting_evidence_id: evt?.linked ?? linkPartner(e.id),
          assertion_payload: e.assertion_payload,
        };
      });

    const band = (b: string | null | undefined): DimensionAssessment => ({ band: b ?? NOT_ESTABLISHED });
    return {
      talent_record_id: recordId,
      ledger_established: true,
      dimensions: {
        identity: band(trustState?.identity_band),
        claims: band(trustState?.claims_band),
        continuity: band(trustState?.continuity_band),
        eligibility: band(trustState?.eligibility_band),
      },
      statements: deriveTrustStatements({
        single_source_only: trustState?.single_source_only ?? false,
        longitudinal_observed: trustState?.longitudinal_observed ?? false,
        verified_control_stale: trustState?.verified_control_stale ?? false,
      }),
      contradictions,
      verifications,
      merge_provenance: mergeOps.map((op) => ({
        operation_id: op.id,
        kind: op.kind,
        role: op.surviving_subject_id === subject.id ? ('survivor' as const) : ('merged' as const),
        completed_at: op.completed_at ? op.completed_at.toISOString() : null,
      })),
      advisory_pointers: advisories.map((a) => a.id),
      proposal_pointers: proposals.map((p) => ({ id: p.id, kind: p.kind })),
    };
  }

  // Per-anchor verification state: the subject's contact anchors, each with the
  // status of its latest VerificationRequest (NONE if never requested). Only the
  // KIND + status cross the wire — the normalized value (PII) never does.
  private async assembleVerifications(
    tenant_id: string,
    members: string[],
    disputedEvidenceIds: ReadonlySet<string>,
  ): Promise<VerificationStateItem[]> {
    const anchorLists = await Promise.all(members.map((m) => this.repo.listAnchorsBySubject(m)));
    const anchors = anchorLists
      .flat()
      .filter((a) => (CONTACT_ANCHOR_KINDS as readonly string[]).includes(a.anchor_kind));
    // Dedupe by (kind, value); keep one probe per distinct anchor.
    const seen = new Set<string>();
    const out: VerificationStateItem[] = [];
    for (const a of anchors) {
      const key = `${a.anchor_kind} ${a.normalized_value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const vr = await this.repo.findLatestVerificationRequest(
        tenant_id,
        a.subject_id,
        a.anchor_kind,
        a.normalized_value,
      );
      out.push({
        anchor_kind: a.anchor_kind,
        status: vr?.status ?? 'NONE',
        // Ruling 4 — DERIVED from the anchor's backing evidence being DISPUTED.
        disputed: disputedEvidenceIds.has(a.source_evidence_id),
      });
    }
    return out;
  }

  async getDossierEvidence(
    tenant_id: string,
    recordId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<DossierEvidencePage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const subject = await this.trust.resolveSubjectRef(this.ref(tenant_id, recordId));
    if (subject === null) return { items: [], next_cursor: null };

    const members = await this.repo.clusterMembers(subject.id);
    const before = decodeCursor(opts.cursor ?? null);
    // Fetch limit+1 to detect a next page.
    const events = await this.repo.listEvidenceEventsBySubjects(members, {
      limit: limit + 1,
      ...(before ? { before } : {}),
    });
    const evidence = await this.repo.listEvidenceBySubjects(members);
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));
    const links = await this.repo.listEvidenceLinksForEvidence(evidence.map((e) => e.id));
    const linksByEvidence = new Map<string, EvidenceLinkRow[]>();
    for (const l of links) {
      for (const eid of [l.from_evidence_id, l.to_evidence_id]) {
        const arr = linksByEvidence.get(eid) ?? [];
        arr.push(l);
        linksByEvidence.set(eid, arr);
      }
    }

    const page = events.slice(0, limit);
    // Every event's evidence_id is a cluster evidence row (invariant) — filter
    // defensively so an item always carries its evidence.
    const items: DossierEvidenceItem[] = page.flatMap((evt) => {
      const ev = evidenceById.get(evt.evidence_id);
      if (ev === undefined) return [];
      return [
        {
          event: {
            id: evt.id,
            event_type: evt.event_type,
            actor: evt.actor,
            reason: evt.reason,
            linked_evidence_id: evt.linked_evidence_id,
            occurred_at: evt.occurred_at.toISOString(),
          },
          evidence: stripStrength(ev),
          links: linksByEvidence.get(evt.evidence_id) ?? [],
        },
      ];
    });
    const last = page[page.length - 1];
    const next_cursor =
      events.length > limit && last !== undefined ? encodeCursor(last.occurred_at, last.id) : null;
    return { items, next_cursor };
  }
}
