import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  IDENTIFIER_VERIFICATION_REQUESTED,
  SOURCE_SYSTEM_TALENT_INTELLIGENCE,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_TTL_SECONDS,
  validateConfirmVerificationRequest,
  validateCreateVerificationRequest,
  type CreateVerificationResponse,
  type VerificationConfirmOutcome,
  type VerificationRefusalCode,
} from '@aramo/intelligence-contracts';

import { identifierKey, type IdentitySnapshot } from '../identity/identity-resolution.js';
import { survivingSubject } from '../identity/identity-resolution.service.js';
import { IdentityMergeSplitService } from '../identity/merge-split.service.js';
import { SourceSystemMismatchError, type IngestPrincipal } from '../ingest/talent-ingest.service.js';
import { assertionContentHash } from '../ingest/ingest-mapping.js';
import { canonicalJson, normalizeEmail, normalizePhone, sha256Hex } from '../normalize.js';
import { PROJECTION_TRIGGER, type ProjectionTrigger } from '../projection/projection.service.js';
import { identifierDigest } from '../projection/projection.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type GoldenTalent,
  type IdentifierKey,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type JsonObject,
  type VerificationRequest,
} from '../repositories/types.js';
import { EMAIL_OTP_METHOD, PORTAL_VERIFICATION_SOURCE, SMS_OTP_METHOD } from '../vocabulary.js';

import { VERIFICATION_CODE_SERVICE, VerificationCodeService, VerificationUnavailableError } from './verification-code.js';
import { VERIFICATION_DELIVERY_PORT, type VerificationDeliveryPort } from './verification-delivery.js';

// ATI-SEP-1 T4 (ADR-0036 §5 "Verification v1") — talent identifier verification.
//
// create  — the request names the talent by its source reference (ATS tuple) or
//           by a portal context. A newer request for the same identifier and
//           subject EXPIRES the older ones (only the latest code works). The
//           outbox fact 'identifier_verification.requested' carries
//           { verification_id, channel, destination } — never the code.
// confirm — 10-minute expiry, 5 attempts then LOCKED. On success:
//           * the identifier becomes VERIFIED on the subject as a TI-originated
//             row (method EMAIL_OTP, source 'aramo-portal', verified_at) —
//             unless the partial unique index already binds it: on the same
//             subject → ALREADY_BOUND; elsewhere → never re-bound, an
//             ANCHOR_CONTRADICTION is opened for review;
//           * a VERIFICATION_OUTCOME assertion (source_kind VERIFICATION,
//             verification_status VERIFIED) is appended — it names the identifier
//             by digest only;
//           * after commit, identity is re-resolved for the newly verified anchor
//             (R2): another subject whose EVERY active reference vouched for the
//             same anchor as verified (the binding was refused at its ingest) is
//             MERGED into this subject (reversible); a subject that only partly
//             vouched gets an ANCHOR_CONTRADICTION; unverified mentions stay
//             discovery only (R3);
//           * the projection is rebuilt (ProjectionTrigger).

export class VerificationRefusedError extends Error {
  constructor(
    readonly code: VerificationRefusalCode,
    readonly details: { issues?: string[]; attempts_remaining?: number } = {},
  ) {
    super(`verification refused: ${code}`);
    this.name = 'VerificationRefusedError';
  }
}

export interface ConfirmResult {
  verification_id: string;
  outcome: VerificationConfirmOutcome;
  intelligence_subject_id: string | null;
  merged_subject_ids: string[];
}

type ConfirmTx =
  | { kind: 'refused'; code: VerificationRefusalCode; attempts_remaining?: number }
  | { kind: 'confirmed'; outcome: VerificationConfirmOutcome; subject_id: string | null; key: IdentifierKey };

const ACTOR_PREFIX = 'verification:';

/** The one surviving, non-merged subject holding an ACTIVE row of `key` (any verification), else null. */
async function uniqueSubjectHolding(repos: IntelligenceRepositories, key: IdentifierKey): Promise<GoldenTalent | null> {
  const rows = await repos.identifiers.listActiveByKey(key);
  const subjects = new Map<string, GoldenTalent>();
  for (const r of rows) {
    const s = await survivingSubject(repos, r.subject_id);
    if (s.resolution_status !== 'MERGED') subjects.set(s.id, s);
  }
  return subjects.size === 1 ? ([...subjects.values()][0] as GoldenTalent) : null;
}

function snapshotVerified(value: unknown): string[] {
  const v = value as Partial<IdentitySnapshot> | null;
  return Array.isArray(v?.verified) ? v.verified : [];
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger('VerificationService');

  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    @Inject(VERIFICATION_CODE_SERVICE) private readonly codes: VerificationCodeService,
    @Inject(VERIFICATION_DELIVERY_PORT) private readonly delivery: VerificationDeliveryPort,
    private readonly mergeSplit: IdentityMergeSplitService,
    @Optional() @Inject(PROJECTION_TRIGGER) private readonly projection?: ProjectionTrigger,
  ) {}

  async create(body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<CreateVerificationResponse> {
    const v = validateCreateVerificationRequest(body);
    if (!v.ok) throw new VerificationRefusedError('INVALID_REQUEST', { issues: v.issues });
    if (!this.codes.available) throw new VerificationUnavailableError();
    const req = v.value;
    const key: IdentifierKey =
      req.identifier_type === 'EMAIL'
        ? { identifier_type: 'EMAIL', normalized_value: normalizeEmail(req.value) }
        : { identifier_type: 'PHONE', normalized_value: normalizePhone(req.value) };
    const channel = req.identifier_type === 'EMAIL' ? 'EMAIL' : 'SMS';
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_SECONDS * 1000);

    const created = await this.uow.run(async (repos) => {
      let subject: GoldenTalent | null = null;
      let referenceId: string | null = null;
      if (req.source_reference !== undefined) {
        if (req.source_reference.source_system_id !== principal.source_system_id) throw new SourceSystemMismatchError();
        const ref = await repos.references.findByTuple(req.source_reference);
        if (ref === null || ref.status !== 'ACTIVE') throw new VerificationRefusedError('REFERENCE_NOT_FOUND');
        subject = await survivingSubject(repos, ref.subject_id);
        referenceId = ref.id;
      } else {
        subject = await uniqueSubjectHolding(repos, key);
      }

      for (const prior of await repos.verifications.listPending(key, subject?.id ?? null)) {
        await repos.verifications.update(prior.id, { status: 'EXPIRED' });
      }

      const id = randomUUID();
      const salt = this.codes.newSalt();
      const row = await repos.verifications.create({
        id,
        subject_id: subject?.id ?? null,
        identifier_type: key.identifier_type as 'EMAIL' | 'PHONE',
        normalized_value: key.normalized_value,
        channel,
        code_salt: salt,
        code_hash: VerificationCodeService.hash(salt, this.codes.codeFor(id, salt)),
        expires_at: expiresAt,
        max_attempts: VERIFICATION_MAX_ATTEMPTS,
        requested_by_reference_id: referenceId,
        requested_by_client_id: principal.client_id,
        portal_session_id: req.portal_context?.portal_session_id ?? null,
      });
      await repos.outbox.enqueue({
        event_type: IDENTIFIER_VERIFICATION_REQUESTED,
        subject_type: 'verification_request',
        subject_id: row.id,
        payload: { verification_id: row.id, channel, destination: key.normalized_value },
        occurred_at: now,
      });
      return row;
    });

    return {
      verification_id: created.id,
      channel,
      status: 'PENDING',
      expires_at: expiresAt.toISOString(),
      delivery: this.delivery.isAvailable(channel) ? 'QUEUED' : 'NOT_AVAILABLE',
    };
  }

  async confirm(verificationId: string, body: unknown, now: Date = new Date()): Promise<ConfirmResult> {
    const v = validateConfirmVerificationRequest(body);
    if (!v.ok) throw new VerificationRefusedError('INVALID_REQUEST', { issues: v.issues });
    const peek = await this.uow.run((repos) => repos.verifications.findById(verificationId));
    if (peek === null) throw new VerificationRefusedError('VERIFICATION_NOT_FOUND');
    const lockKeys = [`verification:${verificationId}`, `id:${identifierKey(peek.identifier_type as 'EMAIL', peek.normalized_value)}`];

    const tx = await this.uow.run<ConfirmTx>(async (repos) => {
      const req = await repos.verifications.findById(verificationId);
      if (req === null) return { kind: 'refused', code: 'VERIFICATION_NOT_FOUND' };
      if (req.status === 'CONFIRMED') return { kind: 'refused', code: 'ALREADY_CONFIRMED' };
      if (req.status === 'LOCKED') return { kind: 'refused', code: 'VERIFICATION_LOCKED', attempts_remaining: 0 };
      if (req.status === 'EXPIRED') return { kind: 'refused', code: 'VERIFICATION_EXPIRED' };
      if (now.getTime() > req.expires_at.getTime()) {
        await repos.verifications.update(req.id, { status: 'EXPIRED' });
        return { kind: 'refused', code: 'VERIFICATION_EXPIRED' };
      }
      if (req.attempts >= req.max_attempts) {
        await repos.verifications.update(req.id, { status: 'LOCKED' });
        return { kind: 'refused', code: 'VERIFICATION_LOCKED', attempts_remaining: 0 };
      }
      if (!VerificationCodeService.matches(req.code_salt, v.value.code, req.code_hash)) {
        const attempts = req.attempts + 1;
        const locked = attempts >= req.max_attempts;
        await repos.verifications.update(req.id, { attempts, ...(locked ? { status: 'LOCKED' as const } : {}) });
        return locked
          ? { kind: 'refused', code: 'VERIFICATION_LOCKED', attempts_remaining: 0 }
          : { kind: 'refused', code: 'INVALID_CODE', attempts_remaining: req.max_attempts - attempts };
      }
      return this.bind(repos, req, now);
    }, { lockKeys });

    if (tx.kind === 'refused') {
      throw new VerificationRefusedError(tx.code, tx.attempts_remaining !== undefined ? { attempts_remaining: tx.attempts_remaining } : {});
    }

    let merged: string[] = [];
    if (tx.subject_id !== null && (tx.outcome === 'BOUND' || tx.outcome === 'ALREADY_BOUND')) {
      try {
        merged = await this.relink(tx.subject_id, tx.key, verificationId);
      } catch (err) {
        this.logger.warn(`re-resolution after verification ${verificationId} failed: ${(err as Error).message}`);
      }
    }
    if (tx.subject_id !== null) await this.projection?.subjectsChanged([tx.subject_id, ...merged]);
    return { verification_id: verificationId, outcome: tx.outcome, intelligence_subject_id: tx.subject_id, merged_subject_ids: merged };
  }

  /** Inside the confirm transaction: bind (or not), append the VERIFICATION_OUTCOME, close the request. */
  private async bind(repos: IntelligenceRepositories, req: VerificationRequest, now: Date): Promise<ConfirmTx> {
    const key: IdentifierKey = { identifier_type: req.identifier_type as 'EMAIL' | 'PHONE', normalized_value: req.normalized_value };
    const subject = req.subject_id !== null ? await survivingSubject(repos, req.subject_id) : await uniqueSubjectHolding(repos, key);
    const method = req.channel === 'SMS' ? SMS_OTP_METHOD : EMAIL_OTP_METHOD;

    let outcome: VerificationConfirmOutcome;
    if (subject === null) {
      outcome = 'UNBOUND';
    } else {
      const bound = await repos.identifiers.findActiveVerified([key]);
      const owners = new Set<string>();
      for (const b of bound) owners.add((await survivingSubject(repos, b.subject_id)).id);
      if (owners.has(subject.id)) {
        outcome = 'ALREADY_BOUND';
      } else if (owners.size > 0) {
        outcome = 'ANCHOR_CONTRADICTION';
        await this.openContradiction(repos, subject.id, [...owners], key, req.id);
      } else {
        await repos.identifiers.create({
          subject_id: subject.id,
          identifier_type: key.identifier_type,
          normalized_value: key.normalized_value,
          verification_status: 'VERIFIED',
          verification_method: method,
          verification_source: PORTAL_VERIFICATION_SOURCE,
          verified_at: now,
          valid_from: now,
          is_primary: false,
          source_reference_id: null,
        });
        outcome = 'BOUND';
      }
      if (outcome === 'BOUND' || outcome === 'ALREADY_BOUND') {
        const payload: JsonObject = {
          target: key.identifier_type,
          result: 'CONFIRMED',
          method,
          verified_at: now.toISOString(),
          identifier_digest: identifierDigest(key.identifier_type, key.normalized_value),
        };
        const assertion = await repos.assertions.create({
          subject_id: subject.id,
          assertion_type: 'VERIFICATION_OUTCOME',
          admission_class: 'B',
          payload,
          source_reference_id: null,
          source_system_id: SOURCE_SYSTEM_TALENT_INTELLIGENCE,
          source_tenant_id: null,
          source_kind: 'VERIFICATION',
          source_event_id: req.id,
          verification_status: 'VERIFIED',
          observed_at: now,
          valid_from: now,
          valid_to: null,
          ai_derived: false,
          content_hash: assertionContentHash({
            assertion_type: 'VERIFICATION_OUTCOME',
            payload,
            source_kind: 'VERIFICATION',
            valid_from: now,
            valid_to: null,
            ai_derived: false,
            source_document_hash: null,
          }),
          source_document_hash: null,
        });
        await repos.assertions.appendEvent({
          assertion_id: assertion.id,
          event_type: 'ASSERTED',
          to_status: 'VALID',
          actor: `${ACTOR_PREFIX}${req.id}`,
          source_event_id: req.id,
        });
      }
    }
    await repos.verifications.update(req.id, {
      status: 'CONFIRMED',
      confirmed_at: now,
      outcome,
      ...(subject !== null ? { subject_id: subject.id } : {}),
    });
    return { kind: 'confirmed', outcome, subject_id: subject?.id ?? null, key };
  }

  private async openContradiction(
    repos: IntelligenceRepositories,
    subjectId: string,
    others: string[],
    key: IdentifierKey,
    verificationId: string,
  ): Promise<void> {
    const related_subject_ids = [...new Set(others)].filter((s) => s !== subjectId).sort();
    const anchor = identifierKey(key.identifier_type as 'EMAIL', key.normalized_value);
    const signature = sha256Hex(canonicalJson({ conflict_type: 'ANCHOR_CONTRADICTION', related_subject_ids, verified_anchor: anchor }));
    const open = await repos.conflicts.listBySubject(subjectId, 'OPEN');
    if (open.some((c) => (c.details as { signature?: string } | null)?.signature === signature)) return;
    await repos.conflicts.create({
      subject_id: subjectId,
      conflict_type: 'ANCHOR_CONTRADICTION',
      related_subject_ids,
      details: { verified_anchor: anchor, verification_id: verificationId, signature },
    });
  }

  /**
   * R2 after a new verified anchor: merge every other subject whose ACTIVE
   * references ALL vouched for the anchor as verified; open a contradiction for
   * a subject that only partly vouched. Unverified mentions are left alone (R3).
   */
  private async relink(subjectId: string, key: IdentifierKey, verificationId: string): Promise<string[]> {
    const anchor = identifierKey(key.identifier_type as 'EMAIL', key.normalized_value);
    const toMerge = await this.uow.run(
      async (repos) => {
        const merge: string[] = [];
        const partial: string[] = [];
        const visited = new Set<string>([subjectId]);
        for (const row of await repos.identifiers.listActiveByKey(key)) {
          // Only a sender's verified claim whose binding was refused (method kept, status UNVERIFIED).
          if (row.verification_status === 'VERIFIED' || row.verification_method === null || row.source_reference_id === null) continue;
          const other = await survivingSubject(repos, row.subject_id);
          if (other.resolution_status === 'MERGED' || visited.has(other.id)) continue;
          visited.add(other.id);
          const refs = (await repos.references.listBySubject(other.id)).filter((r) => r.status === 'ACTIVE');
          const allVouch = refs.length > 0 && refs.every((r) => snapshotVerified(r.last_identity_snapshot).includes(anchor));
          (allVouch ? merge : partial).push(other.id);
        }
        if (partial.length > 0) await this.openContradiction(repos, subjectId, partial, key, verificationId);
        return merge;
      },
      { lockKeys: [`subject:${subjectId}`] },
    );
    const merged: string[] = [];
    for (const other of toMerge) {
      await this.mergeSplit.merge(other, subjectId, `${ACTOR_PREFIX}${verificationId}`, 'R2: verified anchor confirmed by the talent');
      merged.push(other);
    }
    return merged;
  }
}
