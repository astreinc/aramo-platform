import { describe, expect, it } from 'vitest';

import type { UpdateRequisitionRequestDto } from '../lib/dto/update-requisition-request.dto.js';
import { RequisitionRepository } from '../lib/requisition.repository.js';

// PR-0b-1 regression. openings_available is an availability counter mutated
// ONLY by pipeline placement transitions; it was wrongly an ungated write
// field on the create/update DTOs, so any `requisition:edit` holder could
// PATCH it — a second writer against the same integer the pipeline decrement
// owns, with no reconciliation (ADR-0024 §D13c).
//
// This spec drives RequisitionRepository.update() with a body that smuggles
// openings_available (cast, since it is no longer on the DTO) and asserts the
// Prisma `update` payload does NOT carry it — while a legitimate field on the
// same PATCH (title) IS written. A fake Prisma captures the write payload; the
// repository's ctor takes only PrismaService.

// A read-view row that projectView() tolerates: timestamps are Dates, every
// other column resolves to null (Decimal columns included — decimalToFixed2
// accepts null).
const baseRow = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'created_at' || prop === 'updated_at') return new Date(0);
      return null;
    },
  },
);

describe('PR-0b-1 — openings_available is not PATCH-writable', () => {
  it('does not write openings_available on update, but still writes legitimate fields', async () => {
    let capturedData: Record<string, unknown> | undefined;
    // Track 1 T1-b — the write path is now a versioned compare-and-swap:
    // findFirst (existence) → updateMany (the CAS carrying the field payload)
    // → findFirstOrThrow (re-read for the view). The payload assertions still
    // key on the updateMany data (which additionally carries the version bump).
    const fakePrisma = {
      requisition: {
        findFirst: async () => ({ id: 'req-1' }),
        updateMany: async (args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return { count: 1 };
        },
        findFirstOrThrow: async () => baseRow,
      },
    };

    // PR-7 — the SET_PRIORITY policy service is a 2nd ctor arg; this PATCH sets
    // no is_hot, so the gate short-circuits (R3) and the service is never called.
    const repo = new RequisitionRepository(fakePrisma as never, {} as never);

    await repo.update({
      tenant_id: 'tenant-1',
      id: 'req-1',
      input: {
        title: 'Renamed',
        openings_available: 999,
      } as unknown as UpdateRequisitionRequestDto,
      scopes: ['requisition:edit'],
      actor_id: 'actor-1',
      requestId: 'test-req',
    });

    expect(capturedData).toBeDefined();
    // The smuggled counter is dropped …
    expect(Object.keys(capturedData ?? {})).not.toContain('openings_available');
    // … while an ordinary edit on the same PATCH still lands.
    expect(capturedData?.['title']).toBe('Renamed');
  });
});
