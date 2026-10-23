import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import { PromotionService } from '../talent-identity/promotion.service.js';
import { PROMOTION_SYSTEM_ACTOR_ID } from '../talent-identity/promotion.constants.js';

// ATI-SEP-1 T10 WP2 — unit coverage for sourcing promotion on ATS data only. The
// collaborators (sourced_talent / the ATS advisory store / talent_record /
// consent / ingestion) are stubbed; here we prove the ORCHESTRATION: every
// outcome, the arrival → field mapping, system-actor attribution, the tenant
// dedupe 409 (+ the SOURCED_ARRIVAL advisory it raises), and create → consent.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ARRIVAL_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01';
const PAYLOAD_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbb01';
const RECORD_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccc01';
const EXISTING_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddd01';

const REF = { tenant_id: TENANT, sourced_talent_id: ARRIVAL_ID };

function arrival(over: Record<string, unknown> = {}) {
  return {
    id: ARRIVAL_ID,
    tenant_id: TENANT,
    source_channel: 'INDEED',
    external_source_id: 'apply-1',
    normalized_email: 'ada@example.com',
    normalized_phone: '4155550100',
    provenance: {
      ingestion_payload_id: PAYLOAD_ID,
      applicant: { full_name: 'Ada Lovelace', email: 'ada@example.com', phone: '415-555-0100' },
    },
    legal_basis: {},
    arrived_at: new Date('2026-07-04T00:00:00.000Z'),
    created_at: new Date('2026-07-04T00:00:00.000Z'),
    ...over,
  };
}

function makeService(over: {
  arrival?: unknown;
  link?: unknown;
  pending?: unknown[];
  payload?: unknown;
  duplicate?: unknown;
  createError?: unknown;
} = {}) {
  const findById = vi.fn().mockResolvedValue(over.arrival === undefined ? arrival() : over.arrival);
  const sourced = { findById } as never;

  const findArrivalLink = vi.fn().mockResolvedValue(over.link ?? null);
  const listForArrival = vi.fn().mockResolvedValue(over.pending ?? []);
  const findRecordContactKeys = vi
    .fn()
    .mockResolvedValue({ id: EXISTING_ID, record_status: 'live', email: 'ada@example.com', phone: '14155559999' });
  const advisories = { findArrivalLink, listForArrival, findRecordContactKeys } as never;

  const flagArrivalAgainstRecord = vi.fn().mockResolvedValue(true);
  const detection = { flagArrivalAgainstRecord } as never;

  const create = over.createError !== undefined
    ? vi.fn().mockRejectedValue(over.createError)
    : vi.fn().mockResolvedValue({ id: RECORD_ID });
  const findActiveDuplicate = vi.fn().mockResolvedValue(over.duplicate ?? null);
  const talentRecords = { create, findActiveDuplicate } as never;

  const registerSourceDerivedConsent = vi.fn().mockResolvedValue(undefined);
  const sourceConsent = { registerSourceDerivedConsent } as never;

  const payloadFind = vi.fn().mockResolvedValue(
    over.payload === undefined
      ? {
          id: PAYLOAD_ID,
          tenant_id: TENANT,
          source: 'indeed',
          source_class: 'THIRD_PARTY_UNVERIFIED',
          captured_at: new Date('2026-07-04T00:00:00.000Z'),
        }
      : over.payload,
  );
  const ingestion = { findById: payloadFind } as never;

  const service = new PromotionService(sourced, advisories, detection, talentRecords, sourceConsent, ingestion);
  return { service, findById, findArrivalLink, listForArrival, create, findActiveDuplicate, registerSourceDerivedConsent, flagArrivalAgainstRecord };
}

describe('PromotionService.promoteArrival (ATS-local)', () => {
  it('unknown / other-tenant arrival → deferred_unknown_subject', async () => {
    expect((await makeService({ arrival: null }).service.promoteArrival(REF)).status).toBe('deferred_unknown_subject');
    expect(
      (await makeService({ arrival: arrival({ tenant_id: 'other' }) }).service.promoteArrival(REF)).status,
    ).toBe('deferred_unknown_subject');
  });

  it('a linked arrival → already_promoted, no create', async () => {
    const m = makeService({ link: { talent_record_id: EXISTING_ID } });
    expect(await m.service.promoteArrival(REF)).toEqual({ status: 'already_promoted', talent_record_id: EXISTING_ID });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a PENDING ATS advisory gates the mint → deferred_unresolved_identity', async () => {
    const m = makeService({ pending: [{ id: 'adv-1' }] });
    expect((await m.service.promoteArrival(REF)).status).toBe('deferred_unresolved_identity');
    expect(m.listForArrival).toHaveBeenCalledWith(TENANT, ARRIVAL_ID, 'PENDING_REVIEW');
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a one-token name → deferred_no_name; no payload link → deferred_no_basis; no phone → deferred_incomplete_contact', async () => {
    const mono = arrival({ provenance: { ingestion_payload_id: PAYLOAD_ID, applicant: { full_name: 'Cher' } } });
    expect((await makeService({ arrival: mono }).service.promoteArrival(REF)).status).toBe('deferred_no_name');
    const noBasis = arrival({ provenance: { applicant: { full_name: 'Ada Lovelace' } } });
    expect((await makeService({ arrival: noBasis }).service.promoteArrival(REF)).status).toBe('deferred_no_basis');
    const badSource = makeService({
      payload: { id: PAYLOAD_ID, tenant_id: TENANT, source: 'not-a-source', source_class: 'X', captured_at: new Date() },
    });
    expect((await badSource.service.promoteArrival(REF)).status).toBe('deferred_no_basis');
    const noPhone = arrival({
      normalized_phone: null,
      provenance: { ingestion_payload_id: PAYLOAD_ID, applicant: { full_name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    expect((await makeService({ arrival: noPhone }).service.promoteArrival(REF)).status).toBe(
      'deferred_incomplete_contact',
    );
  });

  it('promotes: create (system actor, sourced status, dedupe + PROMOTED link in-txn) then consent with the arrival basis', async () => {
    const m = makeService();
    expect(await m.service.promoteArrival(REF, { requestId: 'req-1' })).toEqual({
      status: 'promoted',
      talent_record_id: RECORD_ID,
    });
    const arg = m.create.mock.calls[0]![0];
    expect(arg).toMatchObject({
      tenant_id: TENANT,
      entered_by_id: PROMOTION_SYSTEM_ACTOR_ID,
      tenant_status: 'sourced',
      dedupe: true,
      sourced_arrival: { sourced_talent_id: ARRIVAL_ID },
      input: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email1: 'ada@example.com',
        phone_cell: '415-555-0100',
        source: 'indeed',
      },
    });
    expect(m.registerSourceDerivedConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        talent_record_id: RECORD_ID,
        source: 'indeed',
        source_class: 'THIRD_PARTY_UNVERIFIED',
        occurred_at: '2026-07-04T00:00:00.000Z',
      }),
    );
  });

  it('a tenant duplicate → 409 TALENT_RECORD_DUPLICATE + a SOURCED_ARRIVAL advisory against the existing record', async () => {
    const m = makeService({ duplicate: { id: EXISTING_ID, reason: 'email' } });
    await expect(m.service.promoteArrival(REF)).rejects.toMatchObject({
      code: 'TALENT_RECORD_DUPLICATE',
      statusCode: 409,
    });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.flagArrivalAgainstRecord).toHaveBeenCalledWith({
      tenant_id: TENANT,
      sourced_talent_id: ARRIVAL_ID,
      talent_record_id: EXISTING_ID,
      kinds: ['EMAIL'],
    });
  });

  it('the in-txn duplicate re-check firing also raises the advisory and rethrows', async () => {
    const err = new AramoError('TALENT_RECORD_DUPLICATE', 'dup', 409, {
      requestId: 'r',
      details: { reason: 'phone', existing_id: EXISTING_ID },
    });
    const m = makeService({ createError: err });
    await expect(m.service.promoteArrival(REF)).rejects.toBe(err);
    expect(m.flagArrivalAgainstRecord).toHaveBeenCalledWith(
      expect.objectContaining({ talent_record_id: EXISTING_ID, sourced_talent_id: ARRIVAL_ID }),
    );
    expect(m.registerSourceDerivedConsent).not.toHaveBeenCalled();
  });

  it('a concurrent promotion that won the link → already_promoted with its record', async () => {
    const m = makeService({ createError: new Error('unique violation') });
    m.findArrivalLink.mockResolvedValueOnce(null).mockResolvedValueOnce({ talent_record_id: EXISTING_ID });
    expect(await m.service.promoteArrival(REF)).toEqual({ status: 'already_promoted', talent_record_id: EXISTING_ID });
  });
});
