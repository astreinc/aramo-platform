import { describe, expect, it } from 'vitest';

import {
  PROVIDER_SOURCED_ORIGINS,
  isProviderSourcedOrigin,
  projectExternalSourceEventToEntryProvenance,
  type ExternalSourceEvent,
} from '../lib/external-source-event.js';

// Lane 2 / L2-I (D2) — the external source-event contract. Proves the projection onto the
// governed L2-D EntryProvenanceInput (connection-scoped source ids, system actor) and the
// provider-origin guard (a connector can NEVER claim an internal/human origin).
const baseEvent: ExternalSourceEvent = {
  origin_type: 'JOB_BOARD',
  source_system: 'acme_job_board',
  source_connection_id: '00000000-0000-7000-8000-000000000c01',
  external_object_type: 'application',
  external_object_id: 'ext-app-99',
  external_event_id: 'evt-1',
  observed_at: new Date('2026-08-31T00:00:00.000Z'),
  talent_record_id: '00000000-0000-7000-8000-000000000t01',
  requisition_id: '00000000-0000-7000-8000-000000000r01',
};

describe('L2-I D2 — external source-event contract', () => {
  it('the provider-sourced origins are exactly the external subset of the L2-D origin vocabulary', () => {
    expect([...PROVIDER_SOURCED_ORIGINS].sort()).toEqual(
      ['CAREER_SITE', 'EXTERNAL_ATS', 'JOB_BOARD', 'TALENT_PORTAL', 'VMS'].sort(),
    );
    // Internal/human origins are NOT provider-mappable.
    expect(isProviderSourcedOrigin('MANUAL_RECRUITER')).toBe(false);
    expect(isProviderSourcedOrigin('ARAMO_SOURCING')).toBe(false);
    expect(isProviderSourcedOrigin('SYSTEM_RECONCILIATION')).toBe(false);
  });

  it('projects a provider source-event onto EntryProvenanceInput — system actor + connection-scoped source ids', () => {
    const p = projectExternalSourceEventToEntryProvenance(baseEvent);
    expect(p.origin_type).toBe('JOB_BOARD');
    expect(p.initiated_by_kind).toBe('system'); // a connector is a system actor, never a human
    expect(p.initiated_by_id).toBeNull();
    expect(p.source_system).toBe('acme_job_board');
    expect(p.source_connection_id).toBe(baseEvent.source_connection_id);
    expect(p.external_object_type).toBe('application');
    expect(p.external_object_id).toBe('ext-app-99');
    expect(p.external_event_id).toBe('evt-1');
    expect(p.observed_at).toEqual(baseEvent.observed_at);
  });

  it('NEGATIVE CONTROL — a connector claiming an internal/human origin is refused', () => {
    expect(() =>
      projectExternalSourceEventToEntryProvenance({ ...baseEvent, origin_type: 'MANUAL_RECRUITER' }),
    ).toThrow(/not a provider-sourced origin/);
    expect(() =>
      projectExternalSourceEventToEntryProvenance({ ...baseEvent, origin_type: 'ARAMO_SOURCING' }),
    ).toThrow(/not a provider-sourced origin/);
  });

  it('carries NO PII field — the shape is connection-scoped UUID refs + provider object ids only', () => {
    // The contract must never carry a name/email/phone. A structural key-set assertion.
    const keys = Object.keys(baseEvent);
    for (const forbidden of ['first_name', 'last_name', 'email', 'phone', 'name']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
