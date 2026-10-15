import { describe, expect, it } from 'vitest';

import {
  MICROSOFT_MEETING_ARTIFACT_SCOPES,
  MICROSOFT_SCHEDULING_SCOPES,
  MS_SCOPE_ONLINE_MEETING_RECORDING_READ,
  MS_SCOPE_ONLINE_MEETING_TRANSCRIPT_READ,
  MicrosoftScopeViolationError,
  assertLeastPrivilegeScopes,
  grantsMeetingArtifacts,
  scopesForCapability,
} from '../lib/domain/graph-scopes.js';

// TIP-E2E INC-3 A1 Part E — the separately authorized `meeting_artifacts`
// delegated capability. The two `.All` read scopes are admitted by EXACT name
// under this capability only; the `.All` defense-in-depth pattern still refuses
// them (and every other `.All`) under baseline and scheduling.

describe('meeting_artifacts capability (A1 Part E)', () => {
  it('is exactly the scheduling set plus the two delegated transcript / recording read scopes', () => {
    expect([...MICROSOFT_MEETING_ARTIFACT_SCOPES]).toEqual([
      ...MICROSOFT_SCHEDULING_SCOPES,
      'OnlineMeetingTranscript.Read.All',
      'OnlineMeetingRecording.Read.All',
    ]);
    expect(scopesForCapability('meeting_artifacts')).toBe(MICROSOFT_MEETING_ARTIFACT_SCOPES);
    expect(() => assertLeastPrivilegeScopes(MICROSOFT_MEETING_ARTIFACT_SCOPES, 'meeting_artifacts')).not.toThrow();
  });

  it('refuses the artifact scopes under baseline and scheduling (scheduling never implies artifacts)', () => {
    for (const capability of ['baseline', 'scheduling'] as const) {
      for (const scope of [MS_SCOPE_ONLINE_MEETING_TRANSCRIPT_READ, MS_SCOPE_ONLINE_MEETING_RECORDING_READ]) {
        expect(() => assertLeastPrivilegeScopes([scope], capability)).toThrow(MicrosoftScopeViolationError);
      }
    }
  });

  it('keeps every other .All scope forbidden even under meeting_artifacts (exact-name admission only)', () => {
    for (const scope of ['OnlineMeetings.ReadWrite.All', 'OnlineMeetingArtifact.Read.All', 'User.Read.All', 'Calls.AccessMedia.All']) {
      expect(() => assertLeastPrivilegeScopes([scope], 'meeting_artifacts')).toThrow(MicrosoftScopeViolationError);
    }
  });

  it('detects the granted transcript scope in a token scope string (bare or resource-qualified), fail closed otherwise', () => {
    expect(grantsMeetingArtifacts('openid OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All')).toBe(true);
    expect(grantsMeetingArtifacts('https://graph.microsoft.com/OnlineMeetingTranscript.Read.All')).toBe(true);
    expect(grantsMeetingArtifacts('openid OnlineMeetings.ReadWrite Calendars.ReadWrite')).toBe(false);
    expect(grantsMeetingArtifacts('')).toBe(false);
  });
});
