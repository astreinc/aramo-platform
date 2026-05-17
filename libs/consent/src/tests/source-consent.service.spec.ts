import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import { SourceConsentService } from '../lib/source-consent.service.js';

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const TALENT_ID = '01900000-0000-7000-8000-000000000010';
const OCCURRED_AT = '2026-05-17T12:00:00.000Z';
const REQUEST_ID = 'req-source-consent-1';

function makeRepoMock(): ConsentRepository {
  return {
    recordConsentEvent: vi.fn().mockResolvedValue({}),
  } as unknown as ConsentRepository;
}

// Helper: extract the (scope, captured_method, metadata) tuples that
// the SourceConsentService wrote, in call order.
function writtenEvents(repo: ConsentRepository): Array<{
  scope: string;
  captured_method: string;
  metadata: Record<string, unknown>;
}> {
  const calls = (repo.recordConsentEvent as ReturnType<typeof vi.fn>).mock.calls;
  return calls.map((c) => {
    const input = c[0] as {
      scope: string;
      captured_method: string;
      metadata: Record<string, unknown>;
    };
    return {
      scope: input.scope,
      captured_method: input.captured_method,
      metadata: input.metadata,
    };
  });
}

describe('SourceConsentService — Group 2 v2.3a source-consent mapping', () => {
  // ===================================================================
  // LOAD-BEARING R5 HONEST-VISIBILITY TEST (PR-13 directive §7 critical).
  //
  // An Indeed-sourced ingest must produce PARTIAL consent:
  // profile_storage / resume_processing / matching granted; contacting
  // LIMITED to the Indeed channel only (via
  // metadata.permitted_channels = ['indeed']). NEVER all-yes general
  // contacting consent. Assigning consent the source did not grant
  // would be widening by aggregation — a direct R5 violation.
  //
  // This is the load-bearing R5 honest-visibility tripwire of PR-13.
  // ===================================================================
  describe('R5 honest-visibility tripwire — Indeed = partial consent', () => {
    it('Indeed: 4 grant events; contacting carries permitted_channels=[indeed] (channel-limited, not all-yes)', async () => {
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'indeed',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const events = writtenEvents(repo);

      // Exactly 4 events (profile_storage + resume_processing +
      // matching + contacting). NOT all-yes universal — but every
      // scope IS represented; the limit lives on the contacting
      // metadata, not on event absence.
      expect(events).toHaveLength(4);

      const scopes = events.map((e) => e.scope).sort();
      expect(scopes).toEqual(
        ['contacting', 'matching', 'profile_storage', 'resume_processing'].sort(),
      );

      // The R5 tripwire: contacting grant is channel-limited to
      // ['indeed']. The runtime resolver's
      // computePermittedChannelsIntersection reads this metadata and
      // denies non-Indeed-channel contacting checks
      // (reason_code: 'channel_not_consented').
      const contacting = events.find((e) => e.scope === 'contacting');
      expect(contacting).toBeDefined();
      expect(contacting?.metadata['permitted_channels']).toEqual(['indeed']);

      // Per-source captured_method: 'import' for Indeed (server-side
      // bulk import; no user actor at consent time).
      expect(events.every((e) => e.captured_method === 'import')).toBe(true);

      // Per-source attribution metadata.
      expect(
        events.every((e) => e.metadata['source_consent_origin'] === 'indeed'),
      ).toBe(true);
    });

    it('Indeed: profile_storage / resume_processing / matching are unrestricted (no channel limit on those)', async () => {
      // Counterpart to the above — the channel-limit lives ONLY on
      // contacting. The other three scopes are normally granted; a
      // runtime check on profile_storage/matching/resume_processing
      // should return allowed without channel restriction.
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'indeed',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const events = writtenEvents(repo);
      for (const scope of ['profile_storage', 'resume_processing', 'matching']) {
        const ev = events.find((e) => e.scope === scope);
        expect(ev).toBeDefined();
        // No permitted_channels key on these — they are not
        // channel-restricted at the consent layer.
        expect(ev?.metadata).not.toHaveProperty('permitted_channels');
      }
    });
  });

  // ===================================================================
  // Per-source mapping tests — each row of the Group 2 v2.3a table.
  // ===================================================================
  describe('GitHub source mapping — profile_storage + matching only (no resume, no contacting)', () => {
    it('GitHub: 2 grant events; no resume_processing (N/A), no contacting (explicit "no")', async () => {
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'github',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const events = writtenEvents(repo);
      expect(events).toHaveLength(2);
      const scopes = events.map((e) => e.scope).sort();
      expect(scopes).toEqual(['matching', 'profile_storage']);
      // No contacting event — empty-scope handling at the resolver
      // returns the explicit "no" semantic the v2.3a table records.
      expect(events.find((e) => e.scope === 'contacting')).toBeUndefined();
      expect(
        events.find((e) => e.scope === 'resume_processing'),
      ).toBeUndefined();
      expect(events.every((e) => e.captured_method === 'import')).toBe(true);
    });
  });

  describe('astre_import source mapping — all four scopes; no special channel restriction', () => {
    it('astre_import: 4 grant events; contacting has no permitted_channels restriction', async () => {
      // "Limited until refreshed" per v2.3a — the 12-month staleness
      // window (R6) handles "until refreshed"; no per-channel
      // restriction is encoded at write time.
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'astre_import',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const events = writtenEvents(repo);
      expect(events).toHaveLength(4);
      const scopes = events.map((e) => e.scope).sort();
      expect(scopes).toEqual(
        ['contacting', 'matching', 'profile_storage', 'resume_processing'].sort(),
      );
      const contacting = events.find((e) => e.scope === 'contacting');
      expect(contacting?.metadata).not.toHaveProperty('permitted_channels');
      // Lawful-basis attribution on profile_storage.
      const profile = events.find((e) => e.scope === 'profile_storage');
      expect(profile?.metadata['lawful_basis']).toBe('legitimate_interest');
    });
  });

  describe('talent_direct source mapping — explicit consent across all four scopes', () => {
    it('talent_direct: 4 grant events with captured_method=self_signup', async () => {
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'talent_direct',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const events = writtenEvents(repo);
      expect(events).toHaveLength(4);
      const scopes = events.map((e) => e.scope).sort();
      expect(scopes).toEqual(
        ['contacting', 'matching', 'profile_storage', 'resume_processing'].sort(),
      );
      // talent_direct = self_signup (the talent submitted the data
      // themselves); the other three sources use 'import'.
      expect(events.every((e) => e.captured_method === 'self_signup')).toBe(true);
      // No channel restriction; consent is broad and explicit.
      const contacting = events.find((e) => e.scope === 'contacting');
      expect(contacting?.metadata).not.toHaveProperty('permitted_channels');
    });
  });

  describe('append-only ledger convention', () => {
    it('writes events via recordConsentEvent with action=granted (libs/consent append-only discipline)', async () => {
      const repo = makeRepoMock();
      const service = new SourceConsentService(repo);

      await service.registerSourceDerivedConsent({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        source: 'indeed',
        occurred_at: OCCURRED_AT,
        requestId: REQUEST_ID,
      });

      const calls = (repo.recordConsentEvent as ReturnType<typeof vi.fn>).mock.calls;
      for (const c of calls) {
        const input = c[0] as { action: string; tenant_id: string; talent_id: string };
        expect(input.action).toBe('granted');
        expect(input.tenant_id).toBe(TENANT_ID);
        expect(input.talent_id).toBe(TALENT_ID);
      }
    });
  });
});
