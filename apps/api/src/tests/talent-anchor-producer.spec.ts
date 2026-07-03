import { describe, expect, it, vi } from 'vitest';
import type { TalentRecordView } from '@aramo/talent-record';
import type { RecordAnchorInput } from '@aramo/talent-trust';

import { TalentAnchorProducerService } from '../talent-anchor/talent-anchor-producer.service.js';

// TR-2a-1 — producer orchestration (mocked deps). Proves it discovers the right
// identifiers from a TalentRecord, normalizes deterministically, de-dupes within
// the record, and records one anchor per distinct (kind, normalized) — via the
// ats→cip TrustService.recordAnchor seam.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

function view(over: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: TALENT,
    tenant_id: TENANT,
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    ...over,
  } as TalentRecordView;
}

function make(recordAnchorImpl?: (i: RecordAnchorInput) => unknown) {
  const recordAnchor = vi.fn(
    recordAnchorImpl ?? ((i: RecordAnchorInput) => ({ anchor: { id: 'x' }, evidence: { id: 'y' }, _i: i })),
  );
  const trust = { recordAnchor } as never;
  const talentRecords = {} as never;
  const svc = new TalentAnchorProducerService(talentRecords, trust);
  return { svc, recordAnchor };
}

describe('TalentAnchorProducerService.recordAnchorsForView', () => {
  it('records EMAIL + PHONE anchors, normalized (email trim+lowercase, phone digit-strip)', async () => {
    const { svc, recordAnchor } = make();
    await svc.recordAnchorsForView(
      view({ email1: '  Ada@Example.COM ', phone_cell: '+1 (555) 123-4567' }),
    );
    expect(recordAnchor).toHaveBeenCalledTimes(2);
    const calls = recordAnchor.mock.calls.map((c) => c[0] as RecordAnchorInput);
    expect(calls).toContainEqual(
      expect.objectContaining({
        tenant_id: TENANT,
        talent_record_id: TALENT,
        anchor_kind: 'EMAIL',
        normalized_value: 'ada@example.com',
        raw_source: '  Ada@Example.COM ',
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        anchor_kind: 'PHONE',
        normalized_value: '15551234567',
      }),
    );
  });

  it('de-dupes within the record (email1 === email2 → one EMAIL anchor)', async () => {
    const { svc, recordAnchor } = make();
    await svc.recordAnchorsForView(
      view({ email1: 'dup@example.com', email2: 'DUP@example.com' }),
    );
    expect(recordAnchor).toHaveBeenCalledTimes(1);
    expect((recordAnchor.mock.calls[0]![0] as RecordAnchorInput).normalized_value).toBe(
      'dup@example.com',
    );
  });

  it('skips empty / whitespace / digitless identifiers', async () => {
    const { svc, recordAnchor } = make();
    await svc.recordAnchorsForView(
      view({ email1: '   ', phone_home: 'n/a', phone_work: '' }),
    );
    expect(recordAnchor).not.toHaveBeenCalled();
  });

  it('counts only NEW anchors (recordAnchor returning null = idempotent skip)', async () => {
    const { svc } = make(() => null); // every anchor already exists
    const written = await svc.recordAnchorsForView(
      view({ email1: 'a@example.com', phone_cell: '5551230000' }),
    );
    expect(written).toBe(0);
  });

  it('records all five identifier slots when distinct', async () => {
    const { svc, recordAnchor } = make();
    await svc.recordAnchorsForView(
      view({
        email1: 'one@example.com',
        email2: 'two@example.com',
        phone_home: '1112223333',
        phone_cell: '4445556666',
        phone_work: '7778889999',
      }),
    );
    expect(recordAnchor).toHaveBeenCalledTimes(5);
  });
});
