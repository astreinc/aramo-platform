import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';

import {
  messageForAddTeamClient,
  messageForAssignRequisition,
  messageForAssignUser,
  messageForFetchCompanyAssignments,
  messageForFetchRequisitionAssignments,
  messageForFetchTeamClients,
  messageForRemoveTeamClient,
  messageForUnassignRequisition,
  messageForUnassignUser,
} from './error-messages';

// Settings S5c-3 — error mapper tests.
//
// PL-94 §2 ruling 1 — uniform idempotency. The DUPLICATE POST is a
// SILENT SUCCESS (never reaches these mappers). The DELETE 404 is
// handled at the consumer as success — these unassign/remove mappers
// are for the rare non-404 error.

describe('messageForAssignUser (D)', () => {
  it('maps 404 to "this company isn’t in your tenant"', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForAssignUser(err).title).toMatch(
      /company isn.t in your tenant/i,
    );
  });
});

describe('messageForFetchCompanyAssignments (D)', () => {
  it('maps 404 to "company isn’t in your tenant"', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForFetchCompanyAssignments(err).title).toMatch(
      /company isn.t in your tenant/i,
    );
  });
});

describe('messageForUnassignUser (D)', () => {
  it('handles non-ApiError throwables gracefully', () => {
    expect(messageForUnassignUser(new Error('boom')).title).toMatch(
      /unexpected error/i,
    );
  });
});

describe('messageForAddTeamClient (E)', () => {
  it('maps 404 to "that company isn’t in your tenant" (cross-tenant company_id)', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForAddTeamClient(err).title).toMatch(
      /company isn.t in your tenant/i,
    );
  });
});

describe('messageForFetchTeamClients (E)', () => {
  it('handles a generic 500 gracefully (cross-tenant teamId is empty, not 404)', () => {
    const err = new ApiError(500, 'boom', 'INTERNAL', {});
    expect(messageForFetchTeamClients(err).title).toBe('boom');
  });
});

describe('messageForRemoveTeamClient (E)', () => {
  it('handles non-ApiError gracefully', () => {
    expect(messageForRemoveTeamClient(new Error('boom')).title).toMatch(
      /unexpected error/i,
    );
  });
});

describe('messageForAssignRequisition (F)', () => {
  it('maps 404 to "requisition isn’t in your tenant"', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForAssignRequisition(err).title).toMatch(
      /requisition isn.t in your tenant/i,
    );
  });
});

describe('messageForFetchRequisitionAssignments (F)', () => {
  it('maps 404 to "requisition isn’t in your tenant"', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForFetchRequisitionAssignments(err).title).toMatch(
      /requisition isn.t in your tenant/i,
    );
  });
});

describe('messageForUnassignRequisition (F)', () => {
  it('handles non-ApiError gracefully', () => {
    expect(messageForUnassignRequisition(new Error('boom')).title).toMatch(
      /unexpected error/i,
    );
  });
});
