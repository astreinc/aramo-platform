import { Inject, Injectable, Optional } from '@nestjs/common';

import { PROJECTION_TRIGGER, type ProjectionTrigger } from '../projection/projection.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type GoldenTalent,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type JsonObject,
  type MergeSplitEvent,
} from '../repositories/types.js';
import type { AccessState, ResolutionStatus } from '../vocabulary.js';

// ATI-SEP-1 T3 (ADR-0036 §5.5) — reversible MERGE / SPLIT. Each runs in ONE
// transaction with Assertion re-pointing enabled for that transaction only,
// records an append-only MergeSplitEvent naming every moved row, and appends a
// REPOINTED AssertionEvent per moved assertion. A split given a merge event id
// restores the merged-away subject exactly (status, references, assertions,
// identifiers, artifacts, conflicts). ResolvedProfileFact rows are a projection:
// they are dropped for both subjects and, after commit, recomputed by the
// projection (T5 ProjectionTrigger, when bound).

export class MergeSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeSplitError';
  }
}

export interface MovedSet {
  reference_ids: string[];
  assertion_ids: string[];
  identifier_ids: string[];
  artifact_ids: string[];
  conflict_ids: string[];
}

export interface MergeMoved extends MovedSet {
  from_prior_resolution_status: ResolutionStatus;
  from_prior_access_state: AccessState;
  into_prior_resolution_status: ResolutionStatus;
  into_prior_access_state: AccessState;
}

export interface SplitSelection {
  reference_ids?: string[];
  assertion_ids?: string[];
  identifier_ids?: string[];
  artifact_ids?: string[];
  conflict_ids?: string[];
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

@Injectable()
export class IdentityMergeSplitService {
  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    @Optional() @Inject(PROJECTION_TRIGGER) private readonly projection?: ProjectionTrigger,
  ) {}

  /** Merge `fromSubjectId` INTO `intoSubjectId`. The from-subject becomes MERGED. */
  async merge(fromSubjectId: string, intoSubjectId: string, actor: string, reason: string): Promise<MergeSplitEvent> {
    const event = await this.mergeTx(fromSubjectId, intoSubjectId, actor, reason);
    await this.projection?.subjectsChanged([event.into_subject_id, event.from_subject_id]);
    return event;
  }

  /**
   * Split rows out of `subjectId`. With `restoreMergeEventId`, the rows that merge
   * moved are returned to the merged-away subject, which regains its prior state.
   * Otherwise the selected rows move to a NEW PROVISIONAL subject. Assertions and
   * identifiers sourced from a moved reference always travel with it.
   */
  async split(
    subjectId: string,
    selection: SplitSelection,
    actor: string,
    reason: string,
    options: { restoreMergeEventId?: string } = {},
  ): Promise<MergeSplitEvent> {
    const event = await this.splitTx(subjectId, selection, actor, reason, options);
    await this.projection?.subjectsChanged([event.from_subject_id, event.into_subject_id]);
    return event;
  }

  private mergeTx(fromSubjectId: string, intoSubjectId: string, actor: string, reason: string): Promise<MergeSplitEvent> {
    if (fromSubjectId === intoSubjectId) return Promise.reject(new MergeSplitError('cannot merge a subject into itself'));
    return this.uow.run(
      async (repos) => {
        const from = await this.live(repos, fromSubjectId);
        const into = await this.live(repos, intoSubjectId);

        const moved: MovedSet = {
          reference_ids: uniq((await repos.references.listBySubject(from.id)).map((r) => r.id)),
          assertion_ids: uniq((await repos.assertions.listBySubject(from.id)).map((a) => a.id)),
          identifier_ids: uniq((await repos.identifiers.listBySubject(from.id)).map((i) => i.id)),
          artifact_ids: uniq((await repos.artifacts.listBySubject(from.id)).map((a) => a.id)),
          conflict_ids: uniq((await repos.conflicts.listBySubject(from.id)).map((c) => c.id)),
        };
        const details: MergeMoved = {
          ...moved,
          from_prior_resolution_status: from.resolution_status as ResolutionStatus,
          from_prior_access_state: from.access_state as AccessState,
          into_prior_resolution_status: into.resolution_status as ResolutionStatus,
          into_prior_access_state: into.access_state as AccessState,
        };
        const event = await repos.mergeSplit.create({
          kind: 'MERGE',
          from_subject_id: from.id,
          into_subject_id: into.id,
          actor,
          reason,
          moved: details as unknown as JsonObject,
        });

        await this.move(repos, moved, from.id, into.id, actor, event.id);
        await repos.subjects.update(from.id, { resolution_status: 'MERGED', merged_into_id: into.id });
        const intoStatus: ResolutionStatus =
          into.resolution_status === 'ACTIVE' || from.resolution_status === 'ACTIVE' ? 'ACTIVE' : 'PROVISIONAL';
        await repos.subjects.update(into.id, {
          resolution_status: intoStatus,
          access_state: await this.accessStateOf(repos, into.id),
        });
        await repos.facts.deleteBySubject(from.id);
        await repos.facts.deleteBySubject(into.id);
        return event;
      },
      { repoint: true, lockKeys: [`subject:${fromSubjectId}`, `subject:${intoSubjectId}`] },
    );
  }

  private splitTx(
    subjectId: string,
    selection: SplitSelection,
    actor: string,
    reason: string,
    options: { restoreMergeEventId?: string } = {},
  ): Promise<MergeSplitEvent> {
    return this.uow.run(
      async (repos) => {
        const subject = await this.live(repos, subjectId);
        const refs = await repos.references.listBySubject(subject.id);
        const assertions = await repos.assertions.listBySubject(subject.id);
        const identifiers = await repos.identifiers.listBySubject(subject.id);
        const artifacts = await repos.artifacts.listBySubject(subject.id);
        const conflicts = await repos.conflicts.listBySubject(subject.id);

        let target: GoldenTalent;
        let wanted: SplitSelection = selection;
        let merge: MergeMoved | null = null;
        if (options.restoreMergeEventId !== undefined) {
          const ev = await repos.mergeSplit.findById(options.restoreMergeEventId);
          if (ev === null || ev.kind !== 'MERGE') throw new MergeSplitError('restore requires a MERGE event');
          if (ev.into_subject_id !== subject.id) throw new MergeSplitError('that merge did not merge into this subject');
          merge = ev.moved as unknown as MergeMoved;
          wanted = merge;
          const original = await repos.subjects.findById(ev.from_subject_id);
          if (original === null || original.resolution_status !== 'MERGED' || original.merged_into_id !== subject.id) {
            throw new MergeSplitError('the merged-away subject is no longer merged into this subject');
          }
          target = original;
        } else {
          target = await repos.subjects.create({ resolution_status: 'PROVISIONAL' });
        }

        const pick = <T extends { id: string }>(rows: T[], ids: string[] | undefined, label: string): string[] => {
          const own = new Set(rows.map((r) => r.id));
          const list = uniq(ids ?? []);
          const missing = list.filter((id) => !own.has(id));
          if (missing.length > 0 && merge === null) {
            throw new MergeSplitError(`${label} ${missing.join(', ')} do not belong to subject ${subject.id}`);
          }
          return list.filter((id) => own.has(id));
        };
        const reference_ids = pick(refs, wanted.reference_ids, 'references');
        const movingRefs = new Set(reference_ids);
        const moved: MovedSet = {
          reference_ids,
          assertion_ids: uniq([
            ...pick(assertions, wanted.assertion_ids, 'assertions'),
            ...assertions.filter((a) => a.source_reference_id !== null && movingRefs.has(a.source_reference_id)).map((a) => a.id),
          ]),
          identifier_ids: uniq([
            ...pick(identifiers, wanted.identifier_ids, 'identifiers'),
            ...identifiers.filter((i) => i.source_reference_id !== null && movingRefs.has(i.source_reference_id)).map((i) => i.id),
          ]),
          artifact_ids: pick(artifacts, wanted.artifact_ids, 'artifacts'),
          conflict_ids: pick(conflicts, wanted.conflict_ids, 'conflicts'),
        };
        if (Object.values(moved).every((l: string[]) => l.length === 0)) throw new MergeSplitError('nothing selected to split');

        const event = await repos.mergeSplit.create({
          kind: 'SPLIT',
          from_subject_id: subject.id,
          into_subject_id: target.id,
          actor,
          reason,
          moved: {
            ...moved,
            ...(options.restoreMergeEventId ? { restores_merge_event_id: options.restoreMergeEventId } : {}),
          } as unknown as JsonObject,
        });
        await this.move(repos, moved, subject.id, target.id, actor, event.id);

        if (merge !== null) {
          await repos.subjects.update(target.id, {
            resolution_status: merge.from_prior_resolution_status,
            merged_into_id: null,
            access_state: await this.accessStateOf(repos, target.id),
          });
          await repos.subjects.update(subject.id, {
            resolution_status: merge.into_prior_resolution_status,
            access_state: await this.accessStateOf(repos, subject.id),
          });
        } else {
          await repos.subjects.update(target.id, { access_state: await this.accessStateOf(repos, target.id) });
          await repos.subjects.update(subject.id, { access_state: await this.accessStateOf(repos, subject.id) });
        }
        await repos.facts.deleteBySubject(subject.id);
        await repos.facts.deleteBySubject(target.id);
        return event;
      },
      { repoint: true, lockKeys: [`subject:${subjectId}`] },
    );
  }

  private async live(repos: IntelligenceRepositories, id: string): Promise<GoldenTalent> {
    const s = await repos.subjects.findById(id);
    if (s === null) throw new MergeSplitError(`subject ${id} not found`);
    if (s.resolution_status === 'MERGED') throw new MergeSplitError(`subject ${id} is already merged`);
    return s;
  }

  private async move(
    repos: IntelligenceRepositories,
    moved: MovedSet,
    fromId: string,
    intoId: string,
    actor: string,
    eventId: string,
  ): Promise<void> {
    await repos.references.repoint(moved.reference_ids, intoId);
    await repos.identifiers.repoint(moved.identifier_ids, intoId);
    await repos.artifacts.repoint(moved.artifact_ids, intoId);
    await repos.conflicts.repoint(moved.conflict_ids, intoId);
    await repos.assertions.repoint(moved.assertion_ids, intoId);
    for (const id of moved.assertion_ids) {
      await repos.assertions.appendEvent({
        assertion_id: id,
        event_type: 'REPOINTED',
        actor,
        details: { from_subject_id: fromId, into_subject_id: intoId, merge_split_event_id: eventId },
      });
    }
  }

  private async accessStateOf(repos: IntelligenceRepositories, subjectId: string): Promise<AccessState> {
    const refs = await repos.references.listBySubject(subjectId);
    return refs.some((r) => r.status === 'ACTIVE') ? 'ACTIVE' : 'AUDIT_RETAINED';
  }
}
