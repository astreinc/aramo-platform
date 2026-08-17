import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import {
  messageForAddMemberError,
  messageForCreateTeamError,
  messageForFetchTeamMembersError,
  messageForRemoveMemberError,
} from './error-messages';

// Settings S5c-2 — error mapper tests.
//
// PL-94 §2 ruling 6 — create-team duplicate-NAME is REJECTED with
// `details: {name, existing_team_id}`. The mapper renders the
// offending name explicitly so the operator can self-correct.

describe('messageForCreateTeamError — the duplicate-name template (ruling 6)', () => {
  it('renders the offending name from details.name (the BE contract)', () => {
    const err = new ApiError(400, 'A team with this name', 'VALIDATION_ERROR', {
      name: 'Alpha',
      existing_team_id: 't-existing',
    });
    const msg = messageForCreateTeamError(err);
    expect(msg.title).toMatch(/A team named "Alpha" already exists/i);
    expect(msg.detail).toMatch(/different name/i);
  });

  it('falls back to SAFE generic copy when details.name is missing (T10-B2/F-018 — never the raw BE message)', () => {
    const err = new ApiError(400, 'bad input', 'VALIDATION_ERROR', {});
    const msg = messageForCreateTeamError(err);
    expect(msg.title).toBe('Something went wrong. Please try again.');
    expect(msg.title).not.toBe('bad input');
  });

  it('handles non-ApiError gracefully', () => {
    const msg = messageForCreateTeamError(new Error('network'));
    expect(msg.title).toMatch(/unexpected error/i);
  });
});

describe('messageForAddMemberError', () => {
  it('maps 404 to per-tenant isolation message', () => {
    const err = new ApiError(404, 'gone', 'NOT_FOUND', {});
    expect(messageForAddMemberError(err).title).toMatch(
      /isn.t in your tenant/i,
    );
  });
});

describe('messageForRemoveMemberError', () => {
  it('handles non-ApiError gracefully', () => {
    const msg = messageForRemoveMemberError(new Error('boom'));
    expect(msg.title).toMatch(/unexpected error/i);
  });
});

describe('messageForFetchTeamMembersError', () => {
  it('maps 404 to per-tenant isolation message', () => {
    const err = new ApiError(404, 'gone', 'NOT_FOUND', {});
    expect(messageForFetchTeamMembersError(err).title).toMatch(
      /isn.t in your tenant/i,
    );
  });
});
