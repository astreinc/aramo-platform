import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import {
  ESTABLISHMENT_MATRIX,
  REQUISITION_CREATE_ESTABLISH,
  assertEstablishmentAuthorization,
  resolveCreateModeFromActorKind,
  type CreationMode,
} from '../lib/establishment-authorization-gate.js';
import type { RecruitingStatus } from '../lib/dto/requisition-status.js';

// Requisition Lane 1-A — the PURE initial-state authority gate proofs (the
// §84 RED-first obligations at the pure-function boundary). Establishment
// authority is DECOUPLED (Directive v1.1 D-A1-GRANT): INTEGRATION reuses the
// existing requisition:import:write; MANUAL-ESTABLISH + SYSTEM use
// requisition:create:establish (held by NO human tenant role in v1).

const REQ_ID = 'req-1a';
const IMPORT_WRITE = 'requisition:import:write';

function reasonOf(fn: () => unknown): { code: string; status: number; reason: unknown } {
  try {
    fn();
    throw new Error('expected a throw, but none occurred');
  } catch (err) {
    if (!(err instanceof AramoError)) throw err;
    return {
      code: err.code,
      status: err.statusCode,
      reason: (err.context.details as { reason?: unknown } | undefined)?.reason,
    };
  }
}

describe('assertEstablishmentAuthorization — creation-mode × status × scopes', () => {
  // Proof 1 — MANUAL, no status -> draft (prior repo default was 'open').
  it('P1: MANUAL with no status resolves to draft (the mode default), NOT the former open', () => {
    const resolved = assertEstablishmentAuthorization({
      mode: 'MANUAL',
      requestedStatus: undefined,
      scopes: [],
      requestId: REQ_ID,
    });
    // BEFORE: the repository defaulted `input.status ?? 'open'`. AFTER: MANUAL
    // resolves to draft. Non-vacuous — assert the EXACT new value and that it
    // is NOT the former default.
    expect(resolved).toBe('draft');
    expect(resolved).not.toBe('open');
  });

  // Proof 2 — MANUAL requesting open, no establish -> 403 authority_required.
  it('P2: MANUAL requesting open WITHOUT create:establish -> 403 establishment_authority_required', () => {
    const r = reasonOf(() =>
      assertEstablishmentAuthorization({
        mode: 'MANUAL',
        requestedStatus: 'open',
        scopes: ['requisition:create', 'requisition:edit'],
        requestId: REQ_ID,
      }),
    );
    expect(r.code).toBe('REQUISITION_INITIAL_STATE_FORBIDDEN');
    expect(r.status).toBe(403);
    expect(r.reason).toBe('establishment_authority_required');
  });

  // Proof 3 — human holding broad scopes but NOT establish -> still draft only.
  it('P3: broad-scoped human (no create:establish) may still ONLY establish draft', () => {
    const broad = [
      'requisition:create',
      'requisition:edit',
      'requisition:edit:status',
      'requisition:read:all',
      'compensation:edit:pay',
    ];
    expect(
      assertEstablishmentAuthorization({
        mode: 'MANUAL',
        requestedStatus: 'draft',
        scopes: broad,
        requestId: REQ_ID,
      }),
    ).toBe('draft');
    // …but 'open' is still refused for the same broad-but-not-establish human.
    expect(
      reasonOf(() =>
        assertEstablishmentAuthorization({
          mode: 'MANUAL',
          requestedStatus: 'open',
          scopes: broad,
          requestId: REQ_ID,
        }),
      ).reason,
    ).toBe('establishment_authority_required');
  });

  // Proof 4 (pure slice) — INTEGRATION import:write requesting open -> open.
  it('P4: INTEGRATION with requisition:import:write requesting open -> open (preserved)', () => {
    expect(
      assertEstablishmentAuthorization({
        mode: 'INTEGRATION',
        requestedStatus: 'open',
        scopes: [IMPORT_WRITE],
        requestId: REQ_ID,
      }),
    ).toBe('open');
    // And INTEGRATION with no status defaults to open (preserved import default).
    expect(
      assertEstablishmentAuthorization({
        mode: 'INTEGRATION',
        requestedStatus: undefined,
        scopes: [IMPORT_WRITE],
        requestId: REQ_ID,
      }),
    ).toBe('open');
  });

  // Proof 5 — INTEGRATION generic-CSV requesting archived/draft/pending_approval -> refused.
  it('P5: INTEGRATION refuses draft/pending_approval/archived (the generic-CSV hole closure)', () => {
    for (const status of ['draft', 'pending_approval', 'archived'] as RecruitingStatus[]) {
      const r = reasonOf(() =>
        assertEstablishmentAuthorization({
          mode: 'INTEGRATION',
          requestedStatus: status,
          scopes: [IMPORT_WRITE],
          requestId: REQ_ID,
        }),
      );
      expect(r.code, status).toBe('REQUISITION_INITIAL_STATE_FORBIDDEN');
      expect(r.status, status).toBe(403);
      expect(r.reason, status).toBe('initial_state_not_allowed_for_mode');
    }
  });

  // Proof 6a — INTEGRATION path enforces requisition:import:write at the floor.
  it('P6a: INTEGRATION WITHOUT requisition:import:write -> 403 establishment_authority_required', () => {
    const r = reasonOf(() =>
      assertEstablishmentAuthorization({
        mode: 'INTEGRATION',
        requestedStatus: 'open',
        scopes: ['requisition:edit', 'compensation:edit:bill'],
        requestId: REQ_ID,
      }),
    );
    expect(r.code).toBe('REQUISITION_INITIAL_STATE_FORBIDDEN');
    expect(r.status).toBe(403);
    expect(r.reason).toBe('establishment_authority_required');
  });

  // Proof 6b — MANUAL non-draft WITHOUT create:establish -> 403.
  it('P6b: MANUAL requesting a non-draft state without create:establish -> 403', () => {
    for (const status of ['open', 'on_hold', 'closed'] as RecruitingStatus[]) {
      expect(
        reasonOf(() =>
          assertEstablishmentAuthorization({
            mode: 'MANUAL',
            requestedStatus: status,
            scopes: ['requisition:create'],
            requestId: REQ_ID,
          }),
        ).code,
        status,
      ).toBe('REQUISITION_INITIAL_STATE_FORBIDDEN');
    }
  });

  // MANUAL-ESTABLISH + SYSTEM positive paths (the create:establish holders).
  it('MANUAL-ESTABLISH (create:establish) may establish open; SYSTEM (create:establish) may establish open', () => {
    expect(
      assertEstablishmentAuthorization({
        mode: 'MANUAL',
        requestedStatus: 'open',
        scopes: [REQUISITION_CREATE_ESTABLISH],
        requestId: REQ_ID,
      }),
    ).toBe('open');
    expect(
      assertEstablishmentAuthorization({
        mode: 'SYSTEM',
        requestedStatus: 'open',
        scopes: [REQUISITION_CREATE_ESTABLISH],
        requestId: REQ_ID,
      }),
    ).toBe('open');
    // SYSTEM without create:establish is refused for authority.
    expect(
      reasonOf(() =>
        assertEstablishmentAuthorization({
          mode: 'SYSTEM',
          requestedStatus: 'open',
          scopes: [],
          requestId: REQ_ID,
        }),
      ).reason,
    ).toBe('establishment_authority_required');
  });

  // Proof 7 — any mode requesting pending_approval/archived -> 403.
  it('P7: pending_approval and archived are refused in EVERY mode', () => {
    const cases: Array<{ mode: CreationMode; scopes: string[] }> = [
      { mode: 'MANUAL', scopes: [REQUISITION_CREATE_ESTABLISH] },
      { mode: 'SYSTEM', scopes: [REQUISITION_CREATE_ESTABLISH] },
      { mode: 'INTEGRATION', scopes: [IMPORT_WRITE] },
    ];
    for (const { mode, scopes } of cases) {
      for (const status of ['pending_approval', 'archived'] as RecruitingStatus[]) {
        const r = reasonOf(() =>
          assertEstablishmentAuthorization({ mode, requestedStatus: status, scopes, requestId: REQ_ID }),
        );
        expect(r.status, `${mode}/${status}`).toBe(403);
        expect(r.code, `${mode}/${status}`).toBe('REQUISITION_INITIAL_STATE_FORBIDDEN');
      }
    }
  });

  it('ESTABLISHMENT_MATRIX encodes the exact allowed sets; resolveCreateModeFromActorKind maps user/system', () => {
    expect(ESTABLISHMENT_MATRIX.MANUAL).toEqual(['draft']);
    expect(ESTABLISHMENT_MATRIX.SYSTEM).toEqual(['draft', 'open']);
    expect(ESTABLISHMENT_MATRIX.INTEGRATION).toEqual([
      'lead',
      'open',
      'on_hold',
      'submittals_closed',
      'closed',
      'canceled',
    ]);
    expect(resolveCreateModeFromActorKind('user')).toBe('MANUAL');
    expect(resolveCreateModeFromActorKind('service_account')).toBe('MANUAL');
    expect(resolveCreateModeFromActorKind('system')).toBe('SYSTEM');
  });
});
