// Account: push preferences (M-A3 §2) and device / session revoke (M-A1 §3.6).
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { deviceLabel, listSessions, revokeSession } from '../devices';
import { closeConfirmed } from '../legal';
import { signedInWithLabel } from '../profile';
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_ROWS,
  savePreferences,
  withPreference,
} from '../preferences';

describe('notification preferences', () => {
  it('"Show subject on lock screen" defaults off; push types default on', () => {
    expect(DEFAULT_PREFERENCES.lock_screen_subject).toBe(false);
    for (const k of ['signed', 'viewed', 'declined', 'signature_needed', 'reminders'] as const)
      expect(DEFAULT_PREFERENCES[k]).toBe(true);
    expect(PREFERENCE_ROWS.map((r) => r.key)).toContain('lock_screen_subject');
  });

  it('a toggle sends all six fields with one changed', () => {
    expect(withPreference(DEFAULT_PREFERENCES, 'viewed', false)).toEqual({
      signed: true,
      viewed: false,
      declined: true,
      signature_needed: true,
      reminders: true,
      lock_screen_subject: false,
    });
  });

  it('PUTs the full body', async () => {
    const body = withPreference(DEFAULT_PREFERENCES, 'lock_screen_subject', true);
    const { net, workspace } = workspaceWith(() => ({ status: 200, body }));
    expect(await savePreferences(workspace, body)).toEqual(body);
    expect(net.calls[0]!.method).toBe('PUT');
    expect(net.calls[0]!.url).toMatch(/\/v1\/sign\/me\/notification-preferences$/);
    expect(net.calls[0]!.body).toEqual(body);
  });
});

describe('devices / sessions', () => {
  const items = [
    {
      device_session_id: 'other',
      platform: 'android',
      app_version: '1.0',
      created_at: '2026-10-01T00:00:00Z',
      last_seen_at: '2026-10-19T00:00:00Z',
      current: false,
    },
    {
      device_session_id: 'mine',
      platform: 'ios',
      app_version: '1.0',
      created_at: '2026-10-02T00:00:00Z',
      last_seen_at: '2026-10-18T00:00:00Z',
      current: true,
    },
  ];

  it('lists this device first, from the auth-service route, with workspace credentials', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: { items } }));
    const list = await listSessions(workspace);
    expect(list.map((s) => s.device_session_id)).toEqual(['mine', 'other']);
    expect(net.calls[0]!.url).toMatch(/\/auth\/native\/sign\/sessions$/);
    expect(net.calls[0]!.headers['Authorization']).toMatch(/^Bearer /);
    expect(deviceLabel(list[0]!)).toBe('iPhone (this device)');
  });

  it('revoking another device DELETEs it and keeps this session', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 204 }));
    const signOut = jest.fn(async () => undefined);
    expect(await revokeSession(workspace, items[0]!, signOut)).toBe('revoked');
    expect(net.calls[0]!.method).toBe('DELETE');
    expect(net.calls[0]!.url).toMatch(/\/auth\/native\/sign\/sessions\/other$/);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('revoking this device signs out here too', async () => {
    const { workspace } = workspaceWith(() => ({ status: 204 }));
    const signOut = jest.fn(async () => undefined);
    expect(await revokeSession(workspace, items[1]!, signOut)).toBe('revoked_current');
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a session that is not the caller’s answers 404 → not_found', async () => {
    const { workspace } = workspaceWith(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    }));
    expect(
      await revokeSession(workspace, { device_session_id: 'x', current: false }, jest.fn()),
    ).toBe('not_found');
  });
});

describe('account close', () => {
  it('needs CLOSE typed exactly', () => {
    expect(closeConfirmed('close')).toBe(false);
    expect(closeConfirmed(' CLOSE ')).toBe(true);
  });
});

describe('signed in with (B-11)', () => {
  it('names Google or Microsoft, and hides the line when unknown', () => {
    expect(signedInWithLabel('google')).toBe('Signed in with Google');
    expect(signedInWithLabel('microsoft')).toBe('Signed in with Microsoft');
    expect(signedInWithLabel(null)).toBeNull();
    expect(signedInWithLabel(undefined)).toBeNull();
  });
});
