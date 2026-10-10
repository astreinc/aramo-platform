import { describe, expect, it, vi } from 'vitest';
import { GraphCalendarError, MicrosoftReauthRequiredError } from '@aramo/microsoft-graph';

import { MicrosoftAuthorizationController } from '../microsoft/microsoft-authorization.controller.js';
import { MicrosoftProviderNotConfiguredError } from '../microsoft/microsoft-provider-not-configured.error.js';
import { CalendarInviteConsentDeniedError } from '../microsoft/calendar-invite-consent-gate.port.js';
import { MeetingAssociationError } from '../microsoft/meeting-association.validator.js';
import {
  MeetingNotFoundError,
  MeetingOrganizerMismatchError,
  MeetingScheduleUnresolvedError,
  MeetingVersionConflictError,
} from '../microsoft/microsoft-scheduling.service.js';

// COMM-C2B Fix — the controller's catch-all used to map EVERY unexpected error
// (including a Secrets Manager AccessDeniedException while saving the client
// secret) to a misleading 409 MICROSOFT_PROVIDER_NOT_CONFIGURED with no log —
// which is why a prod IAM gap surfaced only as "Could not save". These prove the
// corrected mapping: only a genuine no-connection is 409; unexpected/infra
// failures surface as 500 INTERNAL_ERROR (and are logged).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AUTH = { tenant_id: 't1', sub: 'u1', scopes: [] } as any;

function makeController(over: {
  configure?: ReturnType<typeof vi.fn>;
  email?: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scheduling?: Record<string, any>;
} = {}): MicrosoftAuthorizationController {
  const orchestrator = { configureConnection: over.configure ?? vi.fn() };
  const email = { sendRecruiterEmail: over.email ?? vi.fn() };
  const meeting = { createRecruiterMeeting: vi.fn() };
  const scheduling = over.scheduling ?? {};
  return new MicrosoftAuthorizationController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orchestrator as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    email as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meeting as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scheduling as any,
  );
}

describe('MicrosoftAuthorizationController error mapping', () => {
  it('an unexpected/infra failure (e.g. Secrets Manager AccessDenied) surfaces as 500 INTERNAL_ERROR — NOT a masked 409', async () => {
    const awsErr = Object.assign(
      new Error(
        'User: arn:aws:iam::…:user/aramo-api-prod is not authorized to perform: secretsmanager:PutSecretValue',
      ),
      { name: 'AccessDeniedException' },
    );
    const ctl = makeController({ configure: vi.fn().mockRejectedValue(awsErr) });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.configure(AUTH, { client_id: 'a', authority_tenant: 'b', client_secret: 's' } as any, 'rq-1'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
  });

  it('a genuine no-connection maps to 409 MICROSOFT_PROVIDER_NOT_CONFIGURED', async () => {
    const ctl = makeController({
      email: vi.fn().mockRejectedValue(new MicrosoftProviderNotConfiguredError()),
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.sendEmail(AUTH, { talent_record_id: 't', requisition_id: 'r', subject: 's', body: 'b' } as any, 'rq-2', { resolveVisibleRequisitionIds: async () => null } as any),
    ).rejects.toMatchObject({ code: 'MICROSOFT_PROVIDER_NOT_CONFIGURED', statusCode: 409 });
  });

  it('a reauthorization-required error still maps to 409 (regression guard)', async () => {
    const ctl = makeController({
      email: vi.fn().mockRejectedValue(new MicrosoftReauthRequiredError()),
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.sendEmail(AUTH, { talent_record_id: 't', requisition_id: 'r', subject: 's', body: 'b' } as any, 'rq-3', { resolveVisibleRequisitionIds: async () => null } as any),
    ).rejects.toMatchObject({ code: 'MICROSOFT_REAUTHORIZATION_REQUIRED', statusCode: 409 });
  });
});

// COMM-C2B Amendment A1 (M365-SCHED-1) — Outlook scheduling refusals map to typed,
// token-free codes the recruiter UX can distinguish.
describe('MicrosoftAuthorizationController scheduling error mapping (A1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BODY = {} as any;

  it('an invalid / cross-tenant recruiting association → 422 MICROSOFT_MEETING_ASSOCIATION_INVALID', async () => {
    const ctl = makeController({
      scheduling: { scheduleMeeting: vi.fn().mockRejectedValue(new MeetingAssociationError('talent_not_in_tenant', 'x')) },
    });
    await expect(ctl.scheduleCalendarMeeting(AUTH, BODY, 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_MEETING_ASSOCIATION_INVALID',
      statusCode: 422,
    });
  });

  it('missing/stale contacting consent → 409 COMMUNICATION_MEETING_CONSENT_DENIED', async () => {
    const ctl = makeController({
      scheduling: { scheduleMeeting: vi.fn().mockRejectedValue(new CalendarInviteConsentDeniedError('denied')) },
    });
    await expect(ctl.scheduleCalendarMeeting(AUTH, BODY, 'rq')).rejects.toMatchObject({
      code: 'COMMUNICATION_MEETING_CONSENT_DENIED',
      statusCode: 409,
    });
  });

  it('an ambiguous provider outcome → 409 MICROSOFT_SCHEDULING_UNRESOLVED carrying the operation id', async () => {
    const ctl = makeController({
      scheduling: { scheduleMeeting: vi.fn().mockRejectedValue(new MeetingScheduleUnresolvedError('op-9')) },
    });
    await expect(ctl.scheduleCalendarMeeting(AUTH, BODY, 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_SCHEDULING_UNRESOLVED',
      statusCode: 409,
      context: { details: { operation_id: 'op-9' } },
    });
  });

  it('a non-recoverable Graph provider error → 502 MICROSOFT_PROVIDER_ERROR', async () => {
    const ctl = makeController({
      scheduling: { scheduleMeeting: vi.fn().mockRejectedValue(new GraphCalendarError('permanent', 400, 'bad')) },
    });
    await expect(ctl.scheduleCalendarMeeting(AUTH, BODY, 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_PROVIDER_ERROR',
      statusCode: 502,
    });
  });

  it('reschedule by a non-organizer → 403 MICROSOFT_MEETING_NOT_ORGANIZER', async () => {
    const ctl = makeController({
      scheduling: { rescheduleMeeting: vi.fn().mockRejectedValue(new MeetingOrganizerMismatchError()) },
    });
    await expect(ctl.rescheduleCalendarMeeting(AUTH, 'int-1', BODY, 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_MEETING_NOT_ORGANIZER',
      statusCode: 403,
    });
  });

  it('a CAS version conflict on reschedule → 409 MICROSOFT_MEETING_VERSION_CONFLICT', async () => {
    const ctl = makeController({
      scheduling: { rescheduleMeeting: vi.fn().mockRejectedValue(new MeetingVersionConflictError()) },
    });
    await expect(ctl.rescheduleCalendarMeeting(AUTH, 'int-1', BODY, 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_MEETING_VERSION_CONFLICT',
      statusCode: 409,
    });
  });

  it('reading an absent meeting → 404 MICROSOFT_MEETING_NOT_FOUND', async () => {
    const ctl = makeController({
      scheduling: { readMeeting: vi.fn().mockResolvedValue(null) },
    });
    await expect(ctl.readCalendarMeeting(AUTH, 'missing', 'rq')).rejects.toMatchObject({
      code: 'MICROSOFT_MEETING_NOT_FOUND',
      statusCode: 404,
    });
  });
});
