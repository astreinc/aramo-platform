import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  validateTalentErasedRequest,
  validateTalentIngestRequest,
  type IngestRejectionCode,
  type IngestValidationIssue,
  type TalentErasedRequest,
  type TalentErasedResponse,
  type TalentIngestResponse,
} from '@aramo/intelligence-contracts';

import { identifierKey } from '../identity/identity-resolution.js';
import { IdentityResolutionService, survivingSubject } from '../identity/identity-resolution.service.js';
import { GovIdTokenizer } from '../normalize.js';
import { PROJECTION_TRIGGER, type ProjectionTrigger } from '../projection/projection.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type JsonObject,
  type SourceTuple,
} from '../repositories/types.js';
import type { AssertionStatus } from '../vocabulary.js';

import { SINGLE_VALUED_ASSERTION_TYPES, toAssertionDrafts, toResolutionInput } from './ingest-mapping.js';

// ATI-SEP-1 T2 — POST /v1/ingest/talent and /v1/ingest/talent/erased.
//
// Ingest = ONE transaction, serialized per reference (and per verified
// identifier) by advisory locks:
//   inbox replay check → identity resolution (T3) → assertions appended
//   (dedupe by content hash per reference) → assertions of this reference that
//   are absent from the snapshot SUPERSEDED (AssertionEvent + current_status)
//   → inbox row. AFTER COMMIT, when anything changed, the projection is rebuilt
//   (T5 ProjectionTrigger); the projection — not ingest — writes the outbox
//   'golden_talent.profile_updated' when a resolved fact or the trust state moved.
// Erasure (Addendum A1): reference → ERASED; a subject with no ACTIVE reference
// → AUDIT_RETAINED. Evidence is never deleted.

export const GOV_ID_TOKENIZER = Symbol('GOV_ID_TOKENIZER');

export interface IngestPrincipal {
  client_id: string;
  source_system_id: string;
}

export class IngestRejectedError extends Error {
  constructor(
    readonly code: IngestRejectionCode,
    readonly issues: IngestValidationIssue[],
  ) {
    super(`ingestion request refused: ${code}`);
    this.name = 'IngestRejectedError';
  }
}

export class SourceSystemMismatchError extends Error {
  constructor() {
    super('the service client may not ingest for this source_system_id');
    this.name = 'SourceSystemMismatchError';
  }
}

export class EventIdReusedError extends Error {
  constructor(readonly event_id: string) {
    super('source_event_id was already used for a different source reference or event kind');
    this.name = 'EventIdReusedError';
  }
}

const INGEST_ACTOR_PREFIX = 'ingest:';

function str128(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 128) : null;
}

function tupleOf(r: SourceTuple): SourceTuple {
  return { source_system_id: r.source_system_id, source_tenant_id: r.source_tenant_id, external_talent_id: r.external_talent_id };
}

function sameTuple(a: SourceTuple, b: SourceTuple): boolean {
  return (
    a.source_system_id === b.source_system_id &&
    a.source_tenant_id === b.source_tenant_id &&
    a.external_talent_id === b.external_talent_id
  );
}

export function referenceLockKey(t: SourceTuple): string {
  return `ref:${t.source_system_id}|${t.source_tenant_id}|${t.external_talent_id}`;
}

@Injectable()
export class TalentIngestService {
  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    private readonly identity: IdentityResolutionService,
    @Inject(GOV_ID_TOKENIZER) private readonly tokenizer: GovIdTokenizer,
    @Optional() @Inject(PROJECTION_TRIGGER) private readonly projection?: ProjectionTrigger,
  ) {}

  /** Validate, then ingest one full snapshot of a source reference. */
  async ingest(body: unknown, principal: IngestPrincipal): Promise<TalentIngestResponse> {
    const result = validateTalentIngestRequest(body);
    if (!result.ok) {
      await this.quarantine(body, principal, result.code, result.issues);
      throw new IngestRejectedError(result.code, result.issues);
    }
    const req = result.value;
    if (req.source_system_id !== principal.source_system_id) throw new SourceSystemMismatchError();

    // Tokenize government ids BEFORE the transaction (fails closed when the key is absent).
    const resolutionInput = toResolutionInput(req, this.tokenizer);
    const drafts = toAssertionDrafts(req);
    const lockKeys = [
      referenceLockKey(req),
      ...resolutionInput.identifiers
        .filter((i) => i.verified)
        .map((i) => `id:${identifierKey(i.identifier_type, i.normalized_value)}`),
    ];

    const response = await this.uow.run(async (repos) => {
      const replay = await this.replay(repos, req.source_event_id, req, 'TALENT_SNAPSHOT');
      if (replay) return { ...(replay as unknown as TalentIngestResponse), replayed: true };

      const resolution = await this.identity.resolve(repos, resolutionInput);
      const { subject, reference } = resolution;
      const actor = `${INGEST_ACTOR_PREFIX}${principal.client_id}`;

      // Assertions — append new claims, keep identical ones, supersede absent ones.
      const live = await repos.assertions.listLiveByReference(reference.id);
      const liveByHash = new Map(live.map((a) => [a.content_hash, a]));
      const seen = new Set<string>();
      const added: Array<{ id: string; assertion_type: string }> = [];
      for (const d of drafts) {
        if (liveByHash.has(d.content_hash)) {
          seen.add(d.content_hash);
          continue;
        }
        const created = await repos.assertions.create({
          subject_id: subject.id,
          assertion_type: d.assertion_type,
          admission_class: d.admission_class,
          payload: d.payload,
          source_reference_id: reference.id,
          source_system_id: req.source_system_id,
          source_tenant_id: req.source_tenant_id,
          source_kind: d.source_kind,
          source_event_id: req.source_event_id,
          verification_status: 'DECLARED',
          observed_at: d.observed_at,
          valid_from: d.valid_from,
          valid_to: d.valid_to,
          ai_derived: d.ai_derived,
          content_hash: d.content_hash,
          source_document_hash: d.source_document_hash,
        });
        await repos.assertions.appendEvent({
          assertion_id: created.id,
          event_type: 'ASSERTED',
          to_status: 'VALID',
          actor,
          source_event_id: req.source_event_id,
        });
        added.push({ id: created.id, assertion_type: created.assertion_type });
      }

      const superseded: Array<{ id: string; assertion_type: string }> = [];
      for (const a of live) {
        if (seen.has(a.content_hash)) continue;
        await repos.assertions.setStatus(a.id, 'SUPERSEDED');
        await repos.assertions.appendEvent({
          assertion_id: a.id,
          event_type: 'SUPERSEDED',
          from_status: a.current_status as AssertionStatus,
          to_status: 'SUPERSEDED',
          actor,
          source_event_id: req.source_event_id,
          details: { reason: 'absent_from_snapshot' },
        });
        superseded.push({ id: a.id, assertion_type: a.assertion_type });
      }

      // A single-valued fact replaced within one snapshot: link new → old.
      for (const old of superseded) {
        if (!SINGLE_VALUED_ASSERTION_TYPES.has(old.assertion_type)) continue;
        const replacement = added.find((n) => n.assertion_type === old.assertion_type);
        if (replacement) {
          await repos.assertions.appendLink({
            from_assertion_id: replacement.id,
            to_assertion_id: old.id,
            link_type: 'SUPERSEDES',
            actor,
          });
        }
      }

      const changed =
        resolution.created_reference ||
        resolution.created_subject ||
        resolution.identifiers_changed ||
        resolution.conflicts_opened > 0 ||
        added.length > 0 ||
        superseded.length > 0;

      const response: TalentIngestResponse = {
        intelligence_subject_id: subject.id,
        outcome: resolution.created_subject ? 'CREATED' : resolution.created_reference ? 'LINKED' : 'UPDATED',
        resolution: resolution.rule,
        changed,
        assertions_added: added.length,
        assertions_superseded: superseded.length,
        conflicts_opened: resolution.conflicts_opened,
        replayed: false,
      };
      await repos.inbox.create({
        event_id: req.source_event_id,
        ...tupleOf(req),
        kind: 'TALENT_SNAPSHOT',
        outcome: response.outcome,
        response: response as unknown as JsonObject,
      });
      return response;
    }, { lockKeys });
    if (response.changed && !response.replayed) await this.projection?.subjectsChanged([response.intelligence_subject_id]);
    return response;
  }

  /** talent.erased — the reference is ERASED; evidence is retained (Addendum A1). */
  async erase(body: unknown, principal: IngestPrincipal): Promise<TalentErasedResponse> {
    const result = validateTalentErasedRequest(body);
    if (!result.ok) {
      await this.quarantine(body, principal, result.code, result.issues);
      throw new IngestRejectedError(result.code, result.issues);
    }
    const req: TalentErasedRequest = result.value;
    if (req.source_system_id !== principal.source_system_id) throw new SourceSystemMismatchError();

    return this.uow.run(async (repos) => {
      const replay = await this.replay(repos, req.source_event_id, req, 'TALENT_ERASED');
      if (replay) return { ...(replay as unknown as TalentErasedResponse), replayed: true };

      let response: TalentErasedResponse;
      const ref = await repos.references.findByTuple(req);
      if (ref === null) {
        response = { outcome: 'NOT_FOUND', intelligence_subject_id: null, subject_access_state: null, replayed: false };
      } else {
        const alreadyErased = ref.status === 'ERASED';
        if (!alreadyErased) await repos.references.update(ref.id, { status: 'ERASED', erased_at: new Date() });
        const subject = await survivingSubject(repos, ref.subject_id);
        const refs = await repos.references.listBySubject(subject.id);
        const access = refs.some((r) => r.status === 'ACTIVE') ? 'ACTIVE' : 'AUDIT_RETAINED';
        if (subject.access_state !== access) await repos.subjects.update(subject.id, { access_state: access });
        response = {
          outcome: alreadyErased ? 'ALREADY_ERASED' : 'ERASED',
          intelligence_subject_id: subject.id,
          subject_access_state: access,
          replayed: false,
        };
      }
      await repos.inbox.create({
        event_id: req.source_event_id,
        ...tupleOf(req),
        kind: 'TALENT_ERASED',
        outcome: response.outcome,
        response: response as unknown as JsonObject,
      });
      return response;
    }, { lockKeys: [referenceLockKey(req)] });
  }

  private async replay(
    repos: IntelligenceRepositories,
    eventId: string,
    tuple: SourceTuple,
    kind: 'TALENT_SNAPSHOT' | 'TALENT_ERASED',
  ): Promise<JsonObject | null> {
    const prior = await repos.inbox.find(eventId);
    if (prior === null) return null;
    if (prior.kind !== kind || !sameTuple(prior, tuple)) throw new EventIdReusedError(eventId);
    return prior.response as JsonObject;
  }

  /** Keep the refusal (code + issue paths), never the refused body. */
  private async quarantine(
    body: unknown,
    principal: IngestPrincipal,
    code: IngestRejectionCode,
    issues: IngestValidationIssue[],
  ): Promise<void> {
    const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    await this.uow.run((repos) =>
      repos.quarantine.create({
        source_system_id: str128(b['source_system_id']),
        source_event_id: str128(b['source_event_id']),
        client_id: principal.client_id,
        reason: code,
        issues: issues.slice(0, 200).map((i) => ({ path: i.path.slice(0, 512), code: i.code })),
      }),
    );
  }
}

