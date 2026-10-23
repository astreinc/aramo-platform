import { Inject, Injectable, Logger } from '@nestjs/common';
import { GOLDEN_TALENT_PROFILE_UPDATED, TRUST_CHANGE_MARKER } from '@aramo/intelligence-contracts';

import { survivingSubject } from '../identity/identity-resolution.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type Assertion,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type SubjectIdentifier,
  type TrustStateRow,
} from '../repositories/types.js';
import { RETIRED_ASSERTION_STATUSES, type AssertionEventType, type AssertionStatus } from '../vocabulary.js';

import {
  DEFAULT_AVAILABILITY_FRESHNESS_DAYS,
  computeProjection,
  factSignature,
  storedFactValue,
  type ProjectionAssertion,
  type ProjectionIdentifier,
  type ProjectionResult,
} from './projection.js';
import { sameTrust } from './trust-derivation.js';

// ATI-SEP-1 T5 — persists the FULL Golden projection of a subject:
//   * assertion statuses of the view (CONTRADICTED / STALE / REVALIDATED) with an
//     AssertionEvent each, CONTRADICTS links (append-only, never deleted);
//   * ResolvedProfileFact rows (upsert changed, delete vanished);
//   * SubjectTrustState (bands);
//   * on any fact / trust change → outbox 'golden_talent.profile_updated'
//     { intelligence_subject_id, changed_fact_types } (ids and type names only).
// Triggered in-process AFTER COMMIT of ingest / verification / merge / split
// (ProjectionTrigger) and by the scheduled re-assessment (staleness / expiry,
// and repair of any trigger that failed).

export const PROJECTION_TRIGGER = Symbol('PROJECTION_TRIGGER');

/** Post-commit hook: the subjects whose evidence just changed. Never throws. */
export interface ProjectionTrigger {
  subjectsChanged(subjectIds: string[]): Promise<void>;
}

export const TI_AVAILABILITY_FRESHNESS_DAYS_ENV = 'TI_AVAILABILITY_FRESHNESS_DAYS';
export const TI_REASSESSMENT_INTERVAL_MS_ENV = 'TI_REASSESSMENT_INTERVAL_MS';
export const DEFAULT_REASSESSMENT_INTERVAL_MS = 3_600_000;

export function availabilityFreshnessDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[TI_AVAILABILITY_FRESHNESS_DAYS_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AVAILABILITY_FRESHNESS_DAYS;
}

export function reassessmentIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[TI_REASSESSMENT_INTERVAL_MS_ENV]);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_REASSESSMENT_INTERVAL_MS;
}

export function toProjectionAssertion(a: Assertion): ProjectionAssertion {
  return {
    id: a.id,
    assertion_type: a.assertion_type,
    payload: (a.payload ?? {}) as Record<string, unknown>,
    source_reference_id: a.source_reference_id,
    source_system_id: a.source_system_id,
    source_tenant_id: a.source_tenant_id,
    source_kind: a.source_kind,
    verification_status: a.verification_status,
    observed_at: a.observed_at,
    valid_from: a.valid_from,
    valid_to: a.valid_to,
    current_status: a.current_status,
    ai_derived: a.ai_derived,
  };
}

export function toProjectionIdentifier(i: SubjectIdentifier): ProjectionIdentifier {
  return {
    id: i.id,
    identifier_type: i.identifier_type,
    normalized_value: i.normalized_value,
    verification_status: i.verification_status,
    is_primary: i.is_primary,
    status: i.status,
    source_reference_id: i.source_reference_id,
  };
}

/** Assertion ids of a subject backed by an acquired artifact. */
export async function artifactSupportedIds(repos: IntelligenceRepositories, subjectId: string): Promise<Set<string>> {
  const artifacts = await repos.artifacts.listBySubject(subjectId);
  const supports = await repos.artifacts.listSupports(artifacts.map((a) => a.id));
  return new Set(supports.map((s) => s.assertion_id));
}

const STATUS_EVENT: Partial<Record<AssertionStatus, AssertionEventType>> = {
  CONTRADICTED: 'CONTRADICTED',
  STALE: 'STALE',
  VALID: 'REVALIDATED',
};

export interface RebuildResult {
  subject_id: string;
  changed_fact_types: string[];
}

const PROJECTION_ACTOR = 'projection';

@Injectable()
export class ProjectionService implements ProjectionTrigger {
  private readonly logger = new Logger('ProjectionService');

  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  /** Recompute and persist the full Golden projection of one subject. */
  rebuild(subjectId: string, now: Date = new Date()): Promise<RebuildResult> {
    return this.uow.run(
      async (repos) => {
        const subject = await survivingSubject(repos, subjectId);
        if (subject.id !== subjectId) {
          // A merged-away subject projects nothing: its evidence lives on the survivor.
          await repos.facts.deleteBySubject(subjectId);
          return { subject_id: subjectId, changed_fact_types: [] };
        }
        const assertions = (await repos.assertions.listBySubject(subjectId)).filter(
          (a) => !(RETIRED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status),
        );
        const identifiers = await repos.identifiers.listBySubject(subjectId);
        const supported = await artifactSupportedIds(repos, subjectId);
        const result = computeProjection(assertions.map(toProjectionAssertion), identifiers.map(toProjectionIdentifier), {
          now,
          availabilityFreshnessDays: availabilityFreshnessDays(),
          artifactSupported: supported,
        });

        await this.applyStatuses(repos, assertions, result);
        await this.applyContradictionLinks(repos, assertions, result);
        const changed = await this.applyFacts(repos, subjectId, result);
        if (await this.applyTrust(repos, subjectId, result.trust, now)) changed.add(TRUST_CHANGE_MARKER);

        const changed_fact_types = [...changed].sort();
        if (changed_fact_types.length > 0) {
          await repos.outbox.enqueue({
            event_type: GOLDEN_TALENT_PROFILE_UPDATED,
            subject_id: subjectId,
            payload: { intelligence_subject_id: subjectId, changed_fact_types },
            occurred_at: now,
          });
        }
        return { subject_id: subjectId, changed_fact_types };
      },
      { lockKeys: [`projection:${subjectId}`] },
    );
  }

  /** ProjectionTrigger — post-commit; a failure is logged and repaired by the re-assessment job. */
  async subjectsChanged(subjectIds: string[]): Promise<void> {
    for (const id of [...new Set(subjectIds)]) {
      try {
        await this.rebuild(id);
      } catch (err) {
        this.logger.warn(`projection rebuild failed for subject ${id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Scheduled re-assessment: rebuild every non-merged subject whose trust state
   * is missing or older than one interval (staleness, expiry, failed triggers).
   */
  async reassess(now: Date = new Date(), batchSize = 200, intervalMs = reassessmentIntervalMs()): Promise<number> {
    const before = new Date(now.getTime() - intervalMs);
    let done = 0;
    const seen = new Set<string>();
    for (;;) {
      const ids = (await this.uow.run((repos) => repos.subjects.listForReassessment(before, batchSize))).filter((id) => !seen.has(id));
      if (ids.length === 0) return done;
      for (const id of ids) {
        seen.add(id);
        try {
          await this.rebuild(id, now);
          done++;
        } catch (err) {
          this.logger.warn(`re-assessment failed for subject ${id}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async applyStatuses(repos: IntelligenceRepositories, assertions: Assertion[], result: ProjectionResult): Promise<void> {
    for (const a of assertions) {
      const next = result.effective_status.get(a.id);
      if (next === undefined || next === a.current_status) continue;
      const event = STATUS_EVENT[next];
      if (event === undefined) continue;
      await repos.assertions.setStatus(a.id, next);
      await repos.assertions.appendEvent({
        assertion_id: a.id,
        event_type: event,
        from_status: a.current_status as AssertionStatus,
        to_status: next,
        actor: PROJECTION_ACTOR,
      });
    }
  }

  private async applyContradictionLinks(repos: IntelligenceRepositories, assertions: Assertion[], result: ProjectionResult): Promise<void> {
    if (result.contradictions.length === 0) return;
    const existing = await repos.assertions.listLinksFor(assertions.map((a) => a.id));
    const linked = new Set(
      existing.filter((l) => l.link_type === 'CONTRADICTS').flatMap((l) => [`${l.from_assertion_id}|${l.to_assertion_id}`, `${l.to_assertion_id}|${l.from_assertion_id}`]),
    );
    for (const [from, to] of result.contradictions) {
      if (linked.has(`${from}|${to}`)) continue;
      await repos.assertions.appendLink({ from_assertion_id: from, to_assertion_id: to, link_type: 'CONTRADICTS', actor: PROJECTION_ACTOR });
      linked.add(`${from}|${to}`).add(`${to}|${from}`);
    }
  }

  private async applyFacts(repos: IntelligenceRepositories, subjectId: string, result: ProjectionResult): Promise<Set<string>> {
    const changed = new Set<string>();
    const prior = new Map(
      (await repos.facts.listBySubject(subjectId)).map((f) => [`${f.fact_type}|${f.fact_key}`, factSignature(f.value, f.supporting_assertion_ids)]),
    );
    const next = new Set<string>();
    for (const f of result.facts) {
      const key = `${f.fact_type}|${f.fact_key}`;
      next.add(key);
      const value = storedFactValue(f);
      if (prior.get(key) === factSignature(value, f.supporting_assertion_ids)) continue;
      await repos.facts.upsert({ subject_id: subjectId, fact_type: f.fact_type, fact_key: f.fact_key, value, supporting_assertion_ids: f.supporting_assertion_ids });
      changed.add(f.fact_type);
    }
    for (const key of prior.keys()) {
      if (next.has(key)) continue;
      const i = key.indexOf('|');
      await repos.facts.deleteOne(subjectId, key.slice(0, i), key.slice(i + 1));
      changed.add(key.slice(0, i));
    }
    return changed;
  }

  private async applyTrust(repos: IntelligenceRepositories, subjectId: string, trust: TrustStateRow, now: Date): Promise<boolean> {
    const prior = await repos.trust.find(subjectId);
    await repos.trust.upsert(subjectId, trust, now);
    return prior === null || !sameTrust(prior, trust);
  }
}
