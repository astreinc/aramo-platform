import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  errorBody,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// PC-7c — ats-web tenant-user management (identity-admin). Mutations run
// behind the mocked Cognito + mailer ports (backends only; controllers +
// DB live-verified). idempotency 0-by-substrate. State machine: invite
// lifecycle (revoke/resend pending-only, email FAILED-only). refusal CONTRACT:
// revoke/resend no_pending_invite 400, email email_locked 400.

const provider = makeAtsWebProvider();

const USER_A = '00000000-0000-7000-8000-05e100000001';
const MEMBERSHIP_ID = '00000000-0000-7000-8000-33b000000001';

describe('ats-web → tenant users (reads)', () => {
  it('GET /v1/tenant/users returns the user list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant user with a role exist')
      .uponReceiving('a tenant users list read')
      .withRequest('GET', '/v1/tenant/users', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              user_id: uuid(USER_A),
              email: like('ada@astre.example'),
              display_name: like('Ada Lovelace'),
              is_active: like(true),
              invite_status: like('ACTIVE'),
              deactivated_at: null,
              site_id: null,
              role_keys: like(['recruiter']),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  const directoryLike = {
    items: like([{ user_id: uuid(USER_A), display_name: like('Ada Lovelace') }]),
  };
  for (const [path, desc] of [
    ['/v1/tenant/users/directory', 'a tenant users directory read'],
    ['/v1/tenant/assignable-users', 'a tenant assignable-users read'],
  ] as const) {
    it(`GET ${path} returns the id/name list`, async () => {
      await provider
        .addInteraction()
        .given('an ats-web admin and a tenant user with a role exist')
        .uponReceiving(desc)
        .withRequest('GET', path, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
        .willRespondWith(200, (b) => { b.jsonBody(directoryLike); })
        .executeTest(async (mock) => {
          const res = await fetch(`${mock.url}${path}`, { headers: { Cookie: ACCESS_COOKIE } });
          expect(res.status).toBe(200);
        });
    });
  }
});

describe('ats-web → tenant users (lifecycle)', () => {
  it('POST /v1/tenant/users/invitations invites (201)', async () => {
    const BODY = { email: 'newhire@astre.example', display_name: 'New Hire', role_keys: ['recruiter'] };
    await provider
      .addInteraction()
      .given('an ats-web admin can invite a tenant user')
      .uponReceiving('a tenant user invitation')
      .withRequest('POST', '/v1/tenant/users/invitations', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ user_id: uuid(), membership_id: uuid(), invite_status: like('INVITED'), invitation_id: uuid() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/invitations`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('POST disable returns 200', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant user with a role exist')
      .uponReceiving('a tenant user disable')
      .withRequest('POST', `/v1/tenant/users/${USER_A}/disable`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ membership_id: uuid(MEMBERSHIP_ID), changed: like(true), already_disabled: like(false) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/disable`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(200);
      });
  });

  it('POST enable returns 200', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and an inactive tenant user exist')
      .uponReceiving('a tenant user enable')
      .withRequest('POST', `/v1/tenant/users/${USER_A}/enable`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => { b.jsonBody({ membership_id: uuid(MEMBERSHIP_ID) }); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/enable`, { method: 'POST', headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
      });
  });

  it('POST revoke (pending) returns 200', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a pending-invite tenant user exist')
      .uponReceiving('a tenant user invite revoke')
      .withRequest('POST', `/v1/tenant/users/${USER_A}/revoke`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => { b.jsonBody({ revoked: like(true), displayed_status: 'INACTIVE' }); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/revoke`, { method: 'POST', headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
      });
  });

  it('POST resend (pending) returns 200', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a pending-invite tenant user exist')
      .uponReceiving('a tenant user invite resend')
      .withRequest('POST', `/v1/tenant/users/${USER_A}/resend`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => { b.jsonBody({ sent: like('invitation') }); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/resend`, { method: 'POST', headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
      });
  });

  it('PATCH email (failed invite) returns 200', async () => {
    const BODY = { email: 'ada.new@astre.example' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a failed-invite tenant user exist')
      .uponReceiving('a tenant user email change')
      .withRequest('PATCH', `/v1/tenant/users/${USER_A}/email`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => { b.jsonBody({ sent: like('invitation') }); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/email`, {
          method: 'PATCH', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('PATCH roles returns 200', async () => {
    const BODY = { role_keys: ['recruiter'] };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant user with a role exist')
      .uponReceiving('a tenant user roles change')
      .withRequest('PATCH', `/v1/tenant/users/${USER_A}/roles`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          membership_id: uuid(MEMBERSHIP_ID),
          before_role_keys: like(['recruiter']),
          after_role_keys: like(['recruiter']),
          added_role_keys: like([]),
          removed_role_keys: like([]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/roles`, {
          method: 'PATCH', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('ats-web → tenant users (refusals)', () => {
  for (const [action, verb] of [['revoke', 'POST'], ['resend', 'POST']] as const) {
    it(`POST ${action} on an active user returns 400 (no_pending_invite)`, async () => {
      await provider
        .addInteraction()
        .given('an ats-web admin and a tenant user with a role exist')
        .uponReceiving(`a tenant user ${action} on an active membership`)
        .withRequest(verb, `/v1/tenant/users/${USER_A}/${action}`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
        .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'no pending invitation to act on')); })
        .executeTest(async (mock) => {
          const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/${action}`, { method: verb, headers: { Cookie: ACCESS_COOKIE } });
          expect(res.status).toBe(400);
        });
    });
  }

  it('PATCH email on a non-FAILED user returns 400 (email_locked)', async () => {
    const BODY = { email: 'x@astre.example' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant user with a role exist')
      .uponReceiving('a tenant user email change on a locked membership')
      .withRequest('PATCH', `/v1/tenant/users/${USER_A}/email`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'email can only be changed on a failed invite')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/users/${USER_A}/email`, {
          method: 'PATCH', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
