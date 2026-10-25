import { ApiError, errorFromBody } from '../errors';
import { refusalMessage } from '../refusalMessages';
import { etagFor, parseEtag } from '../workspaceClient';

describe('refusal -> typed error (details.reason)', () => {
  it('reads details.reason from the canonical Aramo envelope', () => {
    const e = errorFromBody(429, {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many',
        request_id: 'req-1',
        details: {
          reason: 'reminder_cooldown',
          retry_after_seconds: 1800,
          retry_at: '2026-10-25T10:00:00.000Z',
        },
      },
    });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(429);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.reason).toBe('reminder_cooldown');
    expect(e.is('reminder_cooldown')).toBe(true);
    expect(e.retryAfterSeconds).toBe(1800);
    expect(e.retryAt).toBe('2026-10-25T10:00:00.000Z');
    expect(e.requestId).toBe('req-1');
  });

  it('falls back to the code when there is no reason, and to HTTP_<status> for odd bodies', () => {
    expect(
      errorFromBody(401, {
        error: { code: 'SIGNING_SESSION_EXPIRED', message: 'x', request_id: 'r', details: {} },
      }).reason,
    ).toBe('SIGNING_SESSION_EXPIRED');
    expect(
      errorFromBody(409, { code: 'ENVELOPE_ALREADY_EXECUTED', message: 'flat form' }).reason,
    ).toBe('ENVELOPE_ALREADY_EXECUTED');
    expect(errorFromBody(502, '<html>bad gateway</html>').reason).toBe('HTTP_502');
    expect(errorFromBody(500, undefined).reason).toBe('HTTP_500');
  });

  it('exposes the current revision on 412 and Retry-After when details omit it', () => {
    expect(
      errorFromBody(412, {
        error: {
          code: 'PRECONDITION_FAILED',
          message: '',
          request_id: 'r',
          details: { reason: 'revision_mismatch', current_revision: 4 },
        },
      }).currentRevision,
    ).toBe(4);
    expect(
      errorFromBody(
        429,
        {
          error: {
            code: 'X',
            message: '',
            request_id: 'r',
            details: { reason: 'reminder_daily_limit' },
          },
        },
        '120',
      ).retryAfterSeconds,
    ).toBe(120);
  });

  it('never puts server prose in the Error message (logs see only the reason)', () => {
    const e = errorFromBody(403, {
      error: {
        code: 'FORBIDDEN',
        message: 'secret server detail',
        request_id: 'r',
        details: { reason: 'personal_review_pending' },
      },
    });
    expect(e.message).toBe('personal_review_pending');
    expect(String(e)).not.toContain('secret server detail');
  });

  it('renders the directive copy for the key reasons', () => {
    const m = (reason: string) => refusalMessage({ reason, code: 'X' });
    expect(m('idp_not_permitted_for_tenant')).toBe('Personal accounts sign in with Google.');
    for (const r of [
      'SIGNING_SESSION_EXPIRED',
      'SIGNING_SESSION_INVALID',
      'session_revoked',
      'signing_session_ended',
    ]) {
      expect(m(r)).toBe(
        'This link was replaced or has expired. Open the newest email, or sign in to your inbox.',
      );
    }
    expect(m('something_new')).toBe('Something went wrong. Try again.');
  });
});

describe('ETag helpers (M-A3 §6)', () => {
  it('formats and parses "{id}.{revision}"', () => {
    expect(etagFor({ id: '7f0c', revision: 12 })).toBe('"7f0c.12"');
    expect(parseEtag('"7f0c.12"')).toEqual({ id: '7f0c', revision: 12 });
    expect(parseEtag('W/"7f0c.3"')).toEqual({ id: '7f0c', revision: 3 });
    expect(parseEtag('nonsense')).toBeNull();
    expect(parseEtag(null)).toBeNull();
  });
});
