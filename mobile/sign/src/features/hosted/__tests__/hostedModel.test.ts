import { authenticateHost, type HostAuthDeps } from '../hostAuth';
import {
  HOSTED_COPY,
  hostedReducer,
  initialHostedState,
  isLocked,
  msUntil,
  type HostedEvent,
  type HostedState,
} from '../hostedModel';

const run = (events: HostedEvent[], from: HostedState = initialHostedState) =>
  events.reduce(hostedReducer, from);

describe('hosted mode state machine (M-A5 §3.3)', () => {
  it('stays locked through hand-off, signing and hand-back until the host authenticates', () => {
    let s = initialHostedState;
    expect(s.phase).toBe('handoff');
    for (const e of [{ type: 'BEGIN' }, { type: 'SIGNER_DONE' }] as HostedEvent[]) {
      s = hostedReducer(s, e);
      expect(isLocked(s)).toBe(true);
    }
    expect(s).toMatchObject({ phase: 'handback', end: 'finished' });
    s = hostedReducer(s, { type: 'REQUEST_EXIT' });
    expect(s.phase).toBe('verifying');
    expect(isLocked(s)).toBe(true);
    s = hostedReducer(s, { type: 'AUTH_OK' });
    expect(s.phase).toBe('exited');
    expect(isLocked(s)).toBe(false);
  });

  it('back gestures and hardware back never change anything', () => {
    for (const s of [
      initialHostedState,
      run([{ type: 'BEGIN' }]),
      run([{ type: 'BEGIN' }, { type: 'SIGNER_DONE' }]),
      run([{ type: 'BEGIN' }, { type: 'SIGNER_DONE' }, { type: 'REQUEST_EXIT' }]),
    ]) {
      expect(hostedReducer(s, { type: 'BACK' })).toBe(s);
      expect(isLocked(hostedReducer(s, { type: 'BACK' }))).toBe(true);
    }
  });

  it('a failed authentication returns where it was, still locked, with the reason', () => {
    const s = run([
      { type: 'BEGIN' },
      { type: 'REQUEST_EXIT' },
      { type: 'AUTH_FAILED', message: HOSTED_COPY.authFailed },
    ]);
    expect(s).toMatchObject({ phase: 'signing', authError: HOSTED_COPY.authFailed });
    expect(isLocked(s)).toBe(true);
  });

  it('AUTH_OK means nothing unless the host is authenticating', () => {
    expect(hostedReducer(initialHostedState, { type: 'AUTH_OK' })).toBe(initialHostedState);
    const signing = run([{ type: 'BEGIN' }]);
    expect(hostedReducer(signing, { type: 'AUTH_OK' })).toBe(signing);
  });

  it('expiry ends the signing part and goes to hand-back (also while authenticating)', () => {
    expect(run([{ type: 'BEGIN' }, { type: 'EXPIRED' }])).toMatchObject({
      phase: 'handback',
      end: 'expired',
    });
    expect(run([{ type: 'EXPIRED' }])).toMatchObject({ phase: 'handback', end: 'expired' });
    const s = run([
      { type: 'BEGIN' },
      { type: 'REQUEST_EXIT' },
      { type: 'EXPIRED' },
      { type: 'AUTH_FAILED', message: '' },
    ]);
    expect(s).toMatchObject({ phase: 'handback', end: 'expired' });
  });

  it('cancelling from the hand-off screen still needs the host', () => {
    const s = run([{ type: 'REQUEST_EXIT' }]);
    expect(s).toMatchObject({ phase: 'verifying', end: 'cancelled', resume: 'handoff' });
    expect(isLocked(s)).toBe(true);
  });

  it('computes the time left in the session', () => {
    const now = Date.parse('2026-10-27T10:00:00Z');
    expect(msUntil('2026-10-27T10:30:00Z', now)).toBe(30 * 60 * 1000);
    expect(msUntil('2026-10-27T09:00:00Z', now)).toBe(0);
    expect(msUntil('nonsense', now)).toBe(0);
  });
});

describe('host device authentication (M-A5 §3.3, §8 Q6)', () => {
  const deps = (
    level: number,
    result: 'ok' | 'failed' | 'unavailable',
  ): HostAuthDeps & { prompts: string[] } => {
    const prompts: string[] = [];
    return {
      prompts,
      enrolledLevel: async () => level,
      authenticate: async (p) => {
        prompts.push(p);
        return result;
      },
    };
  };

  it('uses the device prompt (biometrics or passcode) when anything is enrolled', async () => {
    const d = deps(1, 'ok');
    await expect(authenticateHost(d, HOSTED_COPY.authPrompt)).resolves.toBe('ok');
    expect(d.prompts).toEqual([HOSTED_COPY.authPrompt]);
    await expect(authenticateHost(deps(3, 'failed'), 'x')).resolves.toBe('failed');
  });

  it('is unavailable with no passcode and no biometrics (exit then signs out)', async () => {
    const d = deps(0, 'ok');
    await expect(authenticateHost(d, 'x')).resolves.toBe('unavailable');
    expect(d.prompts).toEqual([]);
    await expect(authenticateHost(deps(2, 'unavailable'), 'x')).resolves.toBe('unavailable');
  });

  it('treats a throwing level check as unavailable and a throwing prompt as failed', async () => {
    await expect(
      authenticateHost(
        {
          enrolledLevel: async () => Promise.reject(new Error('x')),
          authenticate: async () => 'ok',
        },
        'x',
      ),
    ).resolves.toBe('unavailable');
    await expect(
      authenticateHost(
        { enrolledLevel: async () => 2, authenticate: async () => Promise.reject(new Error('x')) },
        'x',
      ),
    ).resolves.toBe('failed');
  });
});
