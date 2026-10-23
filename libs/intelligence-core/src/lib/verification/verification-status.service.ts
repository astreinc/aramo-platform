import { Inject, Injectable } from '@nestjs/common';
import {
  VERIFICATION_VALIDITY_DAYS,
  parseReferenceParams,
  type IdentifierVerificationState,
  type PortalVerificationItem,
  type PortalVerificationsResponse,
  type ReferenceVerificationItem,
  type ReferenceVerificationsResponse,
  type VerificationIdentifierType,
} from '@aramo/intelligence-contracts';

import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import { refused, requireActiveReference } from '../lifecycle/lifecycle-access.js';
import { identifierDigest } from '../projection/projection.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type ExternalTalentReference,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type SourceTuple,
  type SubjectIdentifier,
} from '../repositories/types.js';
import { RETIRED_ASSERTION_STATUSES } from '../vocabulary.js';

import { maskDestination } from './verification-delivery.js';

// ATI-SEP-1 T10 M-1 / M-6 (Addendum A3 T10-3) — verification status reads.
//
// M-1 GET /v1/references/:sys/:tenant/:talent/verifications — the contacts THIS
//     reference holds, each VERIFIED (TI or the sender verified it), PENDING (an
//     unexpired one-time code is outstanding) or UNVERIFIED. expires_at: the code's
//     expiry (PENDING) or when re-verification falls due (VERIFIED + 365 days).
// M-6 GET /v1/verifications?reference=… — the portal aggregate: the ATS passes the
//     references the talent holds (TI never maps portal sessions); contacts are
//     de-duplicated across them; an unknown / erased reference contributes nothing.
// Values are always masked. Like POST /v1/verifications these need an ACTIVE
// reference but no entitlement: they report verification of contacts the caller
// already holds.

const DAY_MS = 86_400_000;
type Key = { identifier_type: VerificationIdentifierType; normalized_value: string };
const keyOf = (i: { identifier_type: string; normalized_value: string }) => `${i.identifier_type}|${i.normalized_value}`;

interface Slot {
  key: Key;
  rows: SubjectIdentifier[];
  subjects: Set<string>;
}

@Injectable()
export class VerificationStatusService {
  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  async forReference(tuple: SourceTuple, principal: IngestPrincipal, now: Date = new Date()): Promise<ReferenceVerificationsResponse> {
    return this.uow.run(async (repos) => {
      const { reference, subject } = await requireActiveReference(repos, principal, tuple, { entitled: false });
      const slots = await this.slots(repos, [{ reference, subjectId: subject.id }]);
      const items: ReferenceVerificationItem[] = [];
      for (const slot of slots) {
        const s = await this.state(repos, slot, now);
        const expires =
          s.status === 'PENDING'
            ? s.pending_expires_at
            : s.status === 'VERIFIED' && s.verified_at !== null
              ? new Date(s.verified_at.getTime() + VERIFICATION_VALIDITY_DAYS * DAY_MS)
              : null;
        items.push({
          identifier_type: slot.key.identifier_type,
          value_masked: maskDestination(slot.key.normalized_value),
          status: s.status,
          expires_at: expires?.toISOString() ?? null,
        });
      }
      return { items };
    });
  }

  async forPortal(rawReferences: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<PortalVerificationsResponse> {
    const parsed = parseReferenceParams(rawReferences);
    if (!parsed.ok) throw refused('INVALID_REQUEST', parsed.issues);
    if (parsed.value.some((t) => t.source_system_id !== principal.source_system_id)) throw refused('SOURCE_SYSTEM_MISMATCH');
    return this.uow.run(async (repos) => {
      const held: Array<{ reference: ExternalTalentReference; subjectId: string }> = [];
      for (const tuple of parsed.value) {
        try {
          const g = await requireActiveReference(repos, principal, tuple, { entitled: false });
          held.push({ reference: g.reference, subjectId: g.subject.id });
        } catch {
          // An unknown / erased reference contributes nothing (uniform).
        }
      }
      const items: PortalVerificationItem[] = [];
      for (const slot of await this.slots(repos, held)) {
        const s = await this.state(repos, slot, now);
        items.push({
          identifier_type: slot.key.identifier_type,
          value_masked: maskDestination(slot.key.normalized_value),
          status: s.status,
          verified_at: s.verified_at?.toISOString() ?? null,
          first_seen_at: new Date(Math.min(...slot.rows.map((r) => r.created_at.getTime()))).toISOString(),
          assertion_id: await this.outcomeAssertion(repos, slot),
        });
      }
      return { items };
    });
  }

  /** The contacts of the given references (+ TI verifications of the same values), one slot per (type, value). */
  private async slots(repos: IntelligenceRepositories, held: Array<{ reference: ExternalTalentReference; subjectId: string }>): Promise<Slot[]> {
    const slots = new Map<string, Slot>();
    for (const { reference, subjectId } of held) {
      const rows = (await repos.identifiers.listBySubject(subjectId)).filter(
        (i) => i.status === 'ACTIVE' && (i.identifier_type === 'EMAIL' || i.identifier_type === 'PHONE'),
      );
      const own = rows.filter((i) => i.source_reference_id === reference.id);
      const ownKeys = new Set(own.map(keyOf));
      const ti = rows.filter((i) => i.source_reference_id === null && ownKeys.has(keyOf(i)));
      for (const r of [...own, ...ti]) {
        const k = keyOf(r);
        const slot = slots.get(k) ?? {
          key: { identifier_type: r.identifier_type as VerificationIdentifierType, normalized_value: r.normalized_value },
          rows: [],
          subjects: new Set<string>(),
        };
        if (!slot.rows.some((x) => x.id === r.id)) slot.rows.push(r);
        slot.subjects.add(subjectId);
        slots.set(k, slot);
      }
    }
    return [...slots.values()].sort(
      (a, b) =>
        a.key.identifier_type.localeCompare(b.key.identifier_type) ||
        Math.min(...a.rows.map((r) => r.created_at.getTime())) - Math.min(...b.rows.map((r) => r.created_at.getTime())) ||
        a.key.normalized_value.localeCompare(b.key.normalized_value),
    );
  }

  private async state(
    repos: IntelligenceRepositories,
    slot: Slot,
    now: Date,
  ): Promise<{ status: IdentifierVerificationState; verified_at: Date | null; pending_expires_at: Date | null }> {
    const verified = slot.rows.filter((r) => r.verification_status === 'VERIFIED');
    if (verified.length > 0) {
      const times = verified.map((r) => r.verified_at?.getTime()).filter((t): t is number => t !== undefined);
      return { status: 'VERIFIED', verified_at: times.length > 0 ? new Date(Math.max(...times)) : null, pending_expires_at: null };
    }
    const pending = (await repos.verifications.listPending(slot.key, null)).filter(
      (r) => r.expires_at.getTime() > now.getTime() && (r.subject_id === null || slot.subjects.has(r.subject_id)),
    );
    if (pending.length > 0) {
      return { status: 'PENDING', verified_at: null, pending_expires_at: new Date(Math.max(...pending.map((r) => r.expires_at.getTime()))) };
    }
    return { status: 'UNVERIFIED', verified_at: null, pending_expires_at: null };
  }

  /** The latest live TI verification-outcome assertion of the contact (disputable by the talent). */
  private async outcomeAssertion(repos: IntelligenceRepositories, slot: Slot): Promise<string | null> {
    const digest = identifierDigest(slot.key.identifier_type, slot.key.normalized_value);
    let best: { id: string; at: number } | null = null;
    for (const subjectId of slot.subjects) {
      for (const a of await repos.assertions.listBySubject(subjectId)) {
        if (a.assertion_type !== 'VERIFICATION_OUTCOME' || a.source_kind !== 'VERIFICATION') continue;
        if ((RETIRED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status)) continue;
        if ((a.payload as { identifier_digest?: unknown } | null)?.identifier_digest !== digest) continue;
        if (best === null || a.observed_at.getTime() > best.at) best = { id: a.id, at: a.observed_at.getTime() };
      }
    }
    return best?.id ?? null;
  }
}
