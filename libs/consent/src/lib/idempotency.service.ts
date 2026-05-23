import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';

// IdempotencyService — M4 PR-3 §4.4 / Ruling 7 extraction.
//
// The Aramo workspace has carried an IdempotencyKey table in the consent
// schema since PR-2 ("PR-2 idempotency contract"). Up to M4 PR-2, the
// lookup/persist logic was inlined in ConsentRepository.recordEventCore
// inside its $transaction block. M4 PR-3 introduces the second consumer
// of the same table (libs/submittal POST /v1/submittals).
//
// The directive's Ruling 7 prescribes a shared service in libs/consent
// that both consent and submittal use; this is the extraction. The
// consent repository's existing inline logic stays intact at PR-3
// (no refactor of recordEventCore) — they share the same table by
// convention; ConsentRepository's inlined logic and IdempotencyService
// both maintain the same invariant (replay on hash match, conflict on
// hash mismatch). F36 (NEW per directive §9) tracks the cross-schema
// relocation question for M5/M7 hardening.
//
// Surface (closed):
//   - lookup(input) — returns { kind: 'replay', response_status,
//     response_body } when the key exists with matching hash;
//     throws IDEMPOTENCY_KEY_CONFLICT (409) when the key exists with a
//     different hash; returns { kind: 'proceed' } when the key is new.
//   - persist(input) — writes the IdempotencyKey row after a successful
//     create. The caller MUST call persist AFTER the underlying mutation
//     succeeds so a failed mutation leaves no cached response.
//
// Caller responsibility: the caller computes the request_hash
// (canonicalize-then-sha256 of the request body) and passes it on both
// lookup and persist.

export interface IdempotencyLookupInput {
  tenant_id: string;
  key: string;
  request_hash: string;
  requestId: string;
}

export interface IdempotencyReplay {
  kind: 'replay';
  response_status: number;
  response_body: unknown;
}

export interface IdempotencyProceed {
  kind: 'proceed';
}

export type IdempotencyLookupResult = IdempotencyReplay | IdempotencyProceed;

export interface IdempotencyPersistInput {
  tenant_id: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(input: IdempotencyLookupInput): Promise<IdempotencyLookupResult> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: {
        tenant_id_key: { tenant_id: input.tenant_id, key: input.key },
      },
    });
    if (row === null) {
      return { kind: 'proceed' };
    }
    if (row.request_hash !== input.request_hash) {
      throw new AramoError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Same idempotency key used with a different request body',
        409,
        { requestId: input.requestId },
      );
    }
    return {
      kind: 'replay',
      response_status: row.response_status,
      response_body: row.response_body,
    };
  }

  async persist(input: IdempotencyPersistInput): Promise<void> {
    await this.prisma.idempotencyKey.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        key: input.key,
        request_hash: input.request_hash,
        response_status: input.response_status,
        response_body: input.response_body as never,
      },
    });
  }
}
