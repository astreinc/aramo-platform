import { describe, expect, it, vi } from 'vitest';

import {
  mintPortalVerificationItemId,
  portalVerificationItemIdMatches,
} from '../lib/portal-verification-item-id.js';
import {
  TalentTrustService,
  VERIFICATION_VIEW_FORBIDDEN_FIELDS,
  type PortalVerificationItem,
} from '../lib/talent-trust.service.js';
import type { TalentTrustRepository } from '../lib/talent-trust.repository.js';

// Portal P3a — unit coverage of the item-id surrogate + the re-projected
// verification view + dispute intake. The repository is mocked; the pepper is
// injected so no env is needed.

const PEPPER = 'test-pepper-p3a';
const CLUSTER = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const SUBJ_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const SUBJ_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const ANCHOR_A = 'a0a0a0a0-a0a0-7a0a-8a0a-a0a0a0a0a0a0';
const ANCHOR_B = 'b0b0b0b0-b0b0-7b0b-8b0b-b0b0b0b0b0b0';

describe('portal-verification item-id surrogate', () => {
  it('is deterministic and order-independent (sorted underlying ids)', () => {
    const a = mintPortalVerificationItemId({
      clusterId: CLUSTER,
      itemType: 'ANCHOR',
      underlyingRefIds: [ANCHOR_A, ANCHOR_B],
      pepper: PEPPER,
    });
    const b = mintPortalVerificationItemId({
      clusterId: CLUSTER,
      itemType: 'ANCHOR',
      underlyingRefIds: [ANCHOR_B, ANCHOR_A], // reversed
      pepper: PEPPER,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(portalVerificationItemIdMatches(a, b)).toBe(true);
  });

  it('is per-cluster scoped — a different cluster mints a different id', () => {
    const a = mintPortalVerificationItemId({
      clusterId: CLUSTER,
      itemType: 'ANCHOR',
      underlyingRefIds: [ANCHOR_A],
      pepper: PEPPER,
    });
    const other = mintPortalVerificationItemId({
      clusterId: '99999999-9999-7999-8999-999999999999',
      itemType: 'ANCHOR',
      underlyingRefIds: [ANCHOR_A],
      pepper: PEPPER,
    });
    expect(a).not.toBe(other);
    expect(portalVerificationItemIdMatches(a, other)).toBe(false);
  });

  it('item_type is part of the identity (ANCHOR vs VERIFICATION differ)', () => {
    const anchor = mintPortalVerificationItemId({
      clusterId: CLUSTER, itemType: 'ANCHOR', underlyingRefIds: [ANCHOR_A], pepper: PEPPER,
    });
    const verif = mintPortalVerificationItemId({
      clusterId: CLUSTER, itemType: 'VERIFICATION', underlyingRefIds: [ANCHOR_A], pepper: PEPPER,
    });
    expect(anchor).not.toBe(verif);
  });

  it('a malformed supplied id is a plain non-match (no throw — preserves 404)', () => {
    const derived = mintPortalVerificationItemId({
      clusterId: CLUSTER, itemType: 'ANCHOR', underlyingRefIds: [ANCHOR_A], pepper: PEPPER,
    });
    expect(portalVerificationItemIdMatches('not-hex', derived)).toBe(false);
    expect(portalVerificationItemIdMatches('', derived)).toBe(false);
  });
});

// A repo mock: two subjects each holding the SAME email anchor (deduped to one
// view item spanning both), one CONFIRMED verification on subject A.
function makeRepo(): TalentTrustRepository {
  const anchorsBySubject: Record<string, unknown[]> = {
    [SUBJ_A]: [
      { id: ANCHOR_A, subject_id: SUBJ_A, tenant_id: TENANT_A, anchor_kind: 'EMAIL', normalized_value: 'x@y.com', source_evidence_id: null, source_class: 'SELF_ATTESTED', created_at: new Date('2026-01-01T00:00:00Z') },
    ],
    [SUBJ_B]: [
      { id: ANCHOR_B, subject_id: SUBJ_B, tenant_id: TENANT_B, anchor_kind: 'EMAIL', normalized_value: 'x@y.com', source_evidence_id: null, source_class: 'SELF_ATTESTED', created_at: new Date('2026-02-01T00:00:00Z') },
    ],
  };
  return {
    listAnchorsBySubject: vi.fn(async (s: string) => anchorsBySubject[s] ?? []),
    findLatestVerificationRequest: vi.fn(async (tenant: string) =>
      tenant === TENANT_A
        ? { id: 'vvvvvvvv-vvvv-7vvv-8vvv-vvvvvvvvvvv1', status: 'CONFIRMED', consumed_at: new Date('2026-03-01T00:00:00Z') }
        : null,
    ),
    findOpenPortalDisputeForItem: vi.fn(async () => null),
    createPortalDispute: vi.fn(async (input: { item_id_digest: string }) => ({
      id: 'dddddddd-dddd-7ddd-8ddd-ddddddddddd1',
      cluster_id: CLUSTER,
      item_type: 'VERIFICATION',
      item_id_digest: input.item_id_digest,
      status: 'OPEN',
      resolution_note: null,
      opened_at: new Date('2026-07-15T00:00:00Z'),
      triage_due_at: new Date(), summary_due_at: new Date(), reinvestigation_due_at: new Date(),
      reinvestigation_extended_at: null, ccpa_due_at: new Date(), ccpa_extended_due_at: null,
      withdrawn_at: null, created_at: new Date(), updated_at: new Date(),
    })),
  } as unknown as TalentTrustRepository;
}

function makeService(repo: TalentTrustRepository): TalentTrustService {
  // Only the repo is used by the P3a methods under test (matcher is unused here).
  return new TalentTrustService(repo, {} as never);
}

const SUBJECTS = [
  { tenant_id: TENANT_A, subject_id: SUBJ_A },
  { tenant_id: TENANT_B, subject_id: SUBJ_B },
];

describe('TalentTrustService.aggregateVerifications (re-projection)', () => {
  it('emits ONLY kind + status + dates + item_id — no forbidden field', async () => {
    const items = await makeService(makeRepo()).aggregateVerifications(SUBJECTS, CLUSTER);
    expect(items).toHaveLength(1); // the two EMAIL anchors dedupe to one item
    const item = items[0]!;
    expect(new Set(Object.keys(item))).toEqual(
      new Set(['item_id', 'kind', 'status', 'verified_at', 'first_seen_at']),
    );
    // The binding: no key intersects the ratified forbidden list.
    for (const f of VERIFICATION_VIEW_FORBIDDEN_FIELDS) {
      expect(item as Record<string, unknown>).not.toHaveProperty(f);
    }
    expect(item.kind).toBe('EMAIL');
    expect(item.status).toBe('CONFIRMED'); // subject A confirmed
    expect(item.verified_at).toBe('2026-03-01T00:00:00.000Z');
    expect(item.first_seen_at).toBe('2026-01-01T00:00:00.000Z'); // earliest
  });
});

describe('TalentTrustService.openPortalDispute (resolve + fan-out + idempotency)', () => {
  it('resolves the opaque id, fans out to N work items, fires NO TR-15 transition', async () => {
    const repo = makeRepo();
    const svc = makeService(repo);
    const items = await svc.aggregateVerifications(SUBJECTS, CLUSTER);
    const itemId = items[0]!.item_id;

    await svc.openPortalDispute({
      clusterId: CLUSTER, callerSubjects: SUBJECTS, itemId, statement: 'this is not mine',
      now: new Date('2026-07-15T00:00:00Z'), requestId: 'req-1',
    });

    const create = (repo.createPortalDispute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // VERIFICATION item (subject A confirmed) → fan-out over the confirmed VR only.
    expect(create.item_type).toBe('VERIFICATION');
    expect(create.work_items).toHaveLength(1);
    expect(create.work_items[0].tenant_id).toBe(TENANT_A);
    expect(create.statement_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an item id not in the caller view is a uniform 404', async () => {
    const svc = makeService(makeRepo());
    await expect(
      svc.openPortalDispute({
        clusterId: CLUSTER, callerSubjects: SUBJECTS, itemId: 'f'.repeat(64),
        statement: 's', now: new Date(), requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('one-open-per-item: an existing open dispute is returned, no new row', async () => {
    const repo = makeRepo();
    (repo.findOpenPortalDisputeForItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'existing', status: 'OPEN', opened_at: new Date(),
    });
    const svc = makeService(repo);
    const items = await svc.aggregateVerifications(SUBJECTS, CLUSTER);
    const result = await svc.openPortalDispute({
      clusterId: CLUSTER, callerSubjects: SUBJECTS, itemId: items[0]!.item_id,
      statement: 's', now: new Date(), requestId: 'req-1',
    });
    expect(result.id).toBe('existing');
    expect(repo.createPortalDispute).not.toHaveBeenCalled();
  });
});
