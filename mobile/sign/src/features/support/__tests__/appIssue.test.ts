// M-A12 W1-E.3 — Report app issue sends exactly the message, the app version, the OS, the
// OS version, the device model and the screen: no document data, tokens or logs.
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { ISSUE_COPY, ISSUE_MAX, issueBody, sendAppIssue, validIssue } from '../appIssue';

const FACTS = { appVersion: '1.2.0', os: 'android', osVersion: 34, deviceModel: 'Pixel 8' };

describe('app issue', () => {
  it('builds the exact allowed body', () => {
    const b = issueBody('  The Finish button froze  ', FACTS, 'Account');
    expect(Object.keys(b).sort()).toEqual(['app_version', 'device_model', 'message', 'os', 'os_version', 'screen']);
    expect(b).toEqual({
      message: 'The Finish button froze',
      app_version: '1.2.0',
      os: 'android',
      os_version: '34',
      device_model: 'Pixel 8',
      screen: 'Account',
    });
    expect(issueBody('x'.repeat(ISSUE_MAX + 50), FACTS).message).toHaveLength(ISSUE_MAX);
    expect(issueBody('x', { ...FACTS, os: 'ios' })).not.toHaveProperty('screen');
  });

  it('needs 1 to 2000 characters', () => {
    expect(validIssue('   ')).toBe(false);
    expect(validIssue('ok')).toBe(true);
    expect(validIssue('x'.repeat(ISSUE_MAX + 1))).toBe(false);
  });

  it('POST /v1/sign/me/app-issues; 429 shows the rate-limit copy', async () => {
    const ok = workspaceWith(() => ({ status: 202 }));
    expect(await sendAppIssue(ok.workspace, issueBody('hi', FACTS))).toEqual({ ok: true });
    expect(ok.net.calls[0]).toMatchObject({ method: 'POST' });
    expect(ok.net.calls[0]?.url).toMatch(/\/v1\/sign\/me\/app-issues$/);
    const limited = workspaceWith(() => ({ status: 429, body: { reason: 'rate_limited', code: 'rate_limited' } }));
    expect(await sendAppIssue(limited.workspace, issueBody('hi', FACTS))).toEqual({ ok: false, message: ISSUE_COPY.tooMany });
  });
});
