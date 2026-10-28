// Optional Face ID / fingerprint unlock (M-A1 §4): off by default, local only, and asked
// again after RELOCK_AFTER_MS in the background.
import {
  biometricConfirmPref,
  biometricUnlockPref,
  RELOCK_AFTER_MS,
  shouldRelock,
} from '../biometric';
import { memoryKv } from '../../testing/fakes';

jest.mock('expo-local-authentication', () => ({}));

describe('biometric prefs', () => {
  it('unlock defaults off, signing confirmation defaults on', async () => {
    const kv = memoryKv();
    expect(await biometricUnlockPref.get(kv)).toBe(false);
    expect(await biometricConfirmPref.get(kv)).toBe(true);
  });

  it('unlock persists on and off', async () => {
    const kv = memoryKv();
    await biometricUnlockPref.set(kv, true);
    expect(await biometricUnlockPref.get(kv)).toBe(true);
    await biometricUnlockPref.set(kv, false);
    expect(await biometricUnlockPref.get(kv)).toBe(false);
  });
});

describe('shouldRelock', () => {
  const t0 = 1_000_000;
  it('never relocks without a background visit', () => {
    expect(shouldRelock(null, t0 + RELOCK_AFTER_MS * 10)).toBe(false);
  });

  it('relocks only after the full background interval', () => {
    expect(RELOCK_AFTER_MS).toBe(5 * 60_000);
    expect(shouldRelock(t0, t0 + RELOCK_AFTER_MS - 1)).toBe(false);
    expect(shouldRelock(t0, t0 + RELOCK_AFTER_MS)).toBe(true);
  });
});
