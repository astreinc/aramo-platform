import { Injectable } from '@nestjs/common';
import type { ResolutionRule } from '@aramo/intelligence-contracts';

import type { NameSnapshot } from '../normalize.js';
import type {
  ExternalTalentReference,
  GoldenTalent,
  IntelligenceRepositories,
  JsonObject,
  SourceTuple,
  SubjectIdentifier,
} from '../repositories/types.js';
import type { IdentifierType } from '../vocabulary.js';

import {
  decideResolution,
  identifierKey,
  type IdentitySnapshot,
  type VerifiedAnchorMatch,
} from './identity-resolution.js';

// ATI-SEP-1 T3 — gathers the facts, applies decideResolution, persists the
// outcome: subject, reference, conflicts, and the request's identifiers on the
// subject (VERIFIED where the sender verified it AND the partial unique index
// allows it — a verified identifier already bound to another row is never
// re-bound: it is recorded UNVERIFIED instead). Runs inside the caller's unit of work.

export class ReferenceErasedError extends Error {
  constructor(readonly reference_id: string) {
    super('the source reference was erased and cannot receive new data');
    this.name = 'ReferenceErasedError';
  }
}

export interface ResolutionIdentifier {
  identifier_type: IdentifierType;
  normalized_value: string;
  verified: boolean;
  is_primary: boolean;
  verification_method?: string;
  verification_source?: string;
  verified_at?: Date;
  jurisdiction?: string;
  identifier_class?: string;
}

export interface ResolutionInput {
  tuple: SourceTuple;
  /** Normalized names (normalizeNames). */
  names: NameSnapshot;
  identifiers: ResolutionIdentifier[];
}

export interface ResolutionResult {
  subject: GoldenTalent;
  reference: ExternalTalentReference;
  rule: ResolutionRule;
  created_subject: boolean;
  created_reference: boolean;
  conflicts_opened: number;
  identifiers_changed: boolean;
}

const MAX_MERGE_CHAIN = 32;

/** Follow merged_into_id to the surviving subject. */
export async function survivingSubject(repos: IntelligenceRepositories, subjectId: string): Promise<GoldenTalent> {
  let id = subjectId;
  for (let i = 0; i < MAX_MERGE_CHAIN; i++) {
    const s = await repos.subjects.findById(id);
    if (s === null) throw new Error(`GoldenTalent ${id} not found`);
    if (s.resolution_status !== 'MERGED' || s.merged_into_id === null) return s;
    id = s.merged_into_id;
  }
  throw new Error(`merge chain from ${subjectId} exceeds ${MAX_MERGE_CHAIN}`);
}

/** De-duplicate request identifiers by key; a verified mention wins over an unverified one. */
export function dedupeIdentifiers(list: ResolutionIdentifier[]): ResolutionIdentifier[] {
  const byKey = new Map<string, ResolutionIdentifier>();
  for (const id of list) {
    const key = identifierKey(id.identifier_type, id.normalized_value);
    const prior = byKey.get(key);
    if (!prior || (!prior.verified && id.verified)) byKey.set(key, id);
    else if (id.is_primary && !prior.is_primary) byKey.set(key, { ...prior, is_primary: true });
  }
  return [...byKey.values()];
}

export function snapshotOf(input: ResolutionInput): IdentitySnapshot {
  const ids = dedupeIdentifiers(input.identifiers);
  const keys = (verified: boolean) =>
    ids
      .filter((i) => i.verified === verified)
      .map((i) => identifierKey(i.identifier_type, i.normalized_value))
      .sort();
  return { names: input.names, verified: keys(true), unverified: keys(false) };
}

function asSnapshot(value: unknown): IdentitySnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<IdentitySnapshot>;
  if (!Array.isArray(v.verified) || !Array.isArray(v.unverified)) return null;
  return { names: (v.names ?? {}) as NameSnapshot, verified: v.verified, unverified: v.unverified };
}

@Injectable()
export class IdentityResolutionService {
  async resolve(repos: IntelligenceRepositories, input: ResolutionInput): Promise<ResolutionResult> {
    const snapshot = snapshotOf(input);
    const identifiers = dedupeIdentifiers(input.identifiers);

    const existing = await repos.references.findByTuple(input.tuple);
    if (existing !== null && existing.status !== 'ACTIVE') throw new ReferenceErasedError(existing.id);
    const existingSubject = existing ? await survivingSubject(repos, existing.subject_id) : null;

    // R2/R3 — only VERIFIED request identifiers are matched, and only against
    // ACTIVE VERIFIED identifiers (the partial-unique-index population).
    const verifiedKeys = identifiers
      .filter((i) => i.verified)
      .map((i) => ({ identifier_type: i.identifier_type, normalized_value: i.normalized_value }));
    const rows = await repos.identifiers.findActiveVerified(verifiedKeys);
    const matches: VerifiedAnchorMatch[] = [];
    for (const row of rows) {
      const survivor = await survivingSubject(repos, row.subject_id);
      if (survivor.resolution_status === 'MERGED') continue;
      matches.push({ key: identifierKey(row.identifier_type as IdentifierType, row.normalized_value), subject_id: survivor.id });
    }

    const subject_names: Record<string, NameSnapshot[]> = {};
    for (const subjectId of new Set(matches.map((m) => m.subject_id))) {
      const refs = await repos.references.listBySubject(subjectId);
      subject_names[subjectId] = refs
        .map((r) => asSnapshot(r.last_identity_snapshot)?.names)
        .filter((n): n is NameSnapshot => n !== undefined && Object.keys(n).length > 0);
    }

    const decision = decideResolution({
      request: snapshot,
      existing_reference:
        existing && existingSubject
          ? { id: existing.id, subject_id: existingSubject.id, snapshot: asSnapshot(existing.last_identity_snapshot) }
          : null,
      verified_matches: matches,
      subject_names,
    });

    // Subject.
    let subject: GoldenTalent;
    let created_subject = false;
    if (decision.subject_id === null) {
      subject = await repos.subjects.create({ resolution_status: 'PROVISIONAL' });
      created_subject = true;
    } else {
      subject = (await repos.subjects.findById(decision.subject_id)) as GoldenTalent;
      const patch: { resolution_status?: 'ACTIVE'; access_state?: 'ACTIVE' } = {};
      // A second, independent source linked by a verified anchor corroborates a PROVISIONAL subject.
      if (decision.linked_by_verified_anchor && subject.resolution_status === 'PROVISIONAL') patch.resolution_status = 'ACTIVE';
      // A new ACTIVE reference makes an audit-retained subject reachable again.
      if (subject.access_state !== 'ACTIVE') patch.access_state = 'ACTIVE';
      if (Object.keys(patch).length > 0) subject = await repos.subjects.update(subject.id, patch);
    }

    // Reference.
    let reference: ExternalTalentReference;
    let created_reference = false;
    const snapshotJson = snapshot as unknown as JsonObject;
    if (existing === null) {
      reference = await repos.references.create({ ...input.tuple, subject_id: subject.id, last_identity_snapshot: snapshotJson });
      created_reference = true;
    } else {
      reference = await repos.references.update(existing.id, { last_identity_snapshot: snapshotJson });
      if (reference.subject_id !== subject.id) {
        // The reference pointed at a merged subject — follow it to the survivor.
        await repos.references.repoint([reference.id], subject.id);
        reference = { ...reference, subject_id: subject.id };
      }
    }

    // Conflicts (idempotent per signature while OPEN).
    let conflicts_opened = 0;
    if (decision.conflicts.length > 0) {
      const open = await repos.conflicts.listBySubject(subject.id, 'OPEN');
      const seen = new Set(open.map((c) => (c.details as { signature?: string } | null)?.signature));
      for (const c of decision.conflicts) {
        if (seen.has(c.details.signature)) continue;
        await repos.conflicts.create({
          subject_id: subject.id,
          conflict_type: c.conflict_type,
          related_subject_ids: c.related_subject_ids,
          details: c.details as unknown as JsonObject,
        });
        conflicts_opened++;
      }
    }

    const identifiers_changed = await this.recordIdentifiers(repos, subject.id, reference.id, identifiers);

    return {
      subject,
      reference,
      rule: decision.rule,
      created_subject,
      created_reference,
      conflicts_opened,
      identifiers_changed,
    };
  }

  /**
   * Make the reference's ACTIVE identifier rows equal the request (full snapshot):
   * new keys are added, dropped keys SUPERSEDED, verification/primary updated.
   * Returns true when anything changed.
   */
  private async recordIdentifiers(
    repos: IntelligenceRepositories,
    subjectId: string,
    referenceId: string,
    identifiers: ResolutionIdentifier[],
  ): Promise<boolean> {
    const current = await repos.identifiers.listActiveByReference(referenceId);
    const byKey = new Map<string, SubjectIdentifier>(
      current.map((r) => [identifierKey(r.identifier_type as IdentifierType, r.normalized_value), r]),
    );
    let changed = false;
    const now = new Date();

    const boundElsewhere = async (id: ResolutionIdentifier, selfId?: string): Promise<boolean> => {
      const bound = await repos.identifiers.findActiveVerified([
        { identifier_type: id.identifier_type, normalized_value: id.normalized_value },
      ]);
      return bound.some((b) => b.id !== selfId);
    };

    const verificationFields = (id: ResolutionIdentifier) => ({
      verification_status: 'VERIFIED' as const,
      verification_method: id.verification_method ?? null,
      verification_source: id.verification_source ?? null,
      verified_at: id.verified_at ?? null,
    });

    const wanted = new Set<string>();
    for (const id of identifiers) {
      const key = identifierKey(id.identifier_type, id.normalized_value);
      wanted.add(key);
      const row = byKey.get(key);
      if (row === undefined) {
        const canBind = id.verified && !(await boundElsewhere(id));
        await repos.identifiers.create({
          subject_id: subjectId,
          identifier_type: id.identifier_type,
          normalized_value: id.normalized_value,
          jurisdiction: id.jurisdiction ?? null,
          identifier_class: id.identifier_class ?? null,
          ...(canBind
            ? verificationFields(id)
            : {
                verification_status: 'UNVERIFIED' as const,
                // Keep the sender's claim on record even when the binding is refused.
                verification_method: id.verified ? (id.verification_method ?? null) : null,
                verification_source: id.verified ? (id.verification_source ?? null) : null,
                verified_at: null,
              }),
          valid_from: now,
          is_primary: id.is_primary,
          source_reference_id: referenceId,
        });
        changed = true;
        continue;
      }
      if (row.subject_id !== subjectId) {
        await repos.identifiers.repoint([row.id], subjectId);
        changed = true;
      }
      if (id.verified && row.verification_status !== 'VERIFIED' && !(await boundElsewhere(id, row.id))) {
        await repos.identifiers.update(row.id, { ...verificationFields(id), is_primary: id.is_primary });
        changed = true;
      } else if (!id.verified && row.verification_status === 'VERIFIED') {
        // The source no longer vouches for it — release the binding.
        await repos.identifiers.update(row.id, {
          verification_status: 'UNVERIFIED',
          verified_at: null,
          is_primary: id.is_primary,
        });
        changed = true;
      } else if (row.is_primary !== id.is_primary) {
        await repos.identifiers.update(row.id, { is_primary: id.is_primary });
        changed = true;
      }
    }

    for (const [key, row] of byKey) {
      if (wanted.has(key)) continue;
      await repos.identifiers.update(row.id, { status: 'SUPERSEDED', valid_to: now });
      changed = true;
    }
    return changed;
  }
}
