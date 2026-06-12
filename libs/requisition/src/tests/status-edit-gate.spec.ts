import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { assertStatusOnlyEditScope } from '../lib/status-edit-gate.js';

// PR-A1 Requisition-Gating Rework — the status-only edit gate (the §6
// STATUS-ONLY gate, unit tier). The gate is a pure boundary check:
// (input × scopes) → throw or return. These tests prove the inverted
// restrict-to-subset logic in isolation; the ats-batch2 integration spec
// proves it fires end-to-end on the PATCH route.

const REQUEST_ID = 'req-test-pr-a1-status-gate';

const FULL_EDITOR: readonly string[] = ['requisition:read', 'requisition:edit'];
const STATUS_ONLY: readonly string[] = ['requisition:read', 'requisition:edit:status'];
const READ_ONLY: readonly string[] = ['requisition:read', 'requisition:create'];

describe('PR-A1 status-only edit gate', () => {
  it('full editor (requisition:edit) — any field set passes (unaffected)', () => {
    expect(() =>
      assertStatusOnlyEditScope({
        input: { status: 'closed', title: 'renamed', notes: 'x' },
        scopes: FULL_EDITOR,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('full editor that ALSO holds edit:status — still unaffected (edit precedence)', () => {
    expect(() =>
      assertStatusOnlyEditScope({
        input: { title: 'renamed' },
        scopes: [...FULL_EDITOR, 'requisition:edit:status'],
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('status-only holder — status-only PATCH passes', () => {
    expect(() =>
      assertStatusOnlyEditScope({
        input: { status: 'on_hold' },
        scopes: STATUS_ONLY,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('status-only holder — empty body passes (no-op)', () => {
    expect(() =>
      assertStatusOnlyEditScope({ input: {}, scopes: STATUS_ONLY, requestId: REQUEST_ID }),
    ).not.toThrow();
  });

  it('status-only holder — undefined-valued non-status keys are not "present" (pass)', () => {
    expect(() =>
      assertStatusOnlyEditScope({
        input: { status: 'closed', title: undefined },
        scopes: STATUS_ONLY,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('status-only holder — any non-status field → 403 status_only_edit_field_violation', () => {
    let caught: AramoError | undefined;
    try {
      assertStatusOnlyEditScope({
        input: { status: 'closed', title: 'renamed' },
        scopes: STATUS_ONLY,
        requestId: REQUEST_ID,
      });
    } catch (e) {
      caught = e as AramoError;
    }
    expect(caught).toBeInstanceOf(AramoError);
    const e = caught as AramoError;
    expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(e.context.details?.['reason']).toBe('status_only_edit_field_violation');
    expect(e.context.details?.['allowed_fields']).toEqual(['status']);
    expect(e.context.details?.['attempted_fields']).toEqual(['title']);
  });

  it('status-only holder — non-status field WITHOUT status is still rejected', () => {
    expect(() =>
      assertStatusOnlyEditScope({
        input: { notes: 'x' },
        scopes: STATUS_ONLY,
        requestId: REQUEST_ID,
      }),
    ).toThrow(/only the status field/);
  });

  it('neither scope (read-only recruiter) → 403 requisition_edit_scope_missing', () => {
    let caught: AramoError | undefined;
    try {
      assertStatusOnlyEditScope({
        input: { status: 'closed' },
        scopes: READ_ONLY,
        requestId: REQUEST_ID,
      });
    } catch (e) {
      caught = e as AramoError;
    }
    expect(caught).toBeInstanceOf(AramoError);
    const e = caught as AramoError;
    expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(e.context.details?.['reason']).toBe('requisition_edit_scope_missing');
    expect(e.context.details?.['required_scopes']).toEqual([
      'requisition:edit',
      'requisition:edit:status',
    ]);
  });
});
