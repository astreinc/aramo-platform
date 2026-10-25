// Directive §3.7 / acceptance §12.3: tokens live only in Keychain / Keystore.
import * as SecureStore from 'expo-secure-store';

import { getInstallationId } from '../installation';
import { SECURE_KEYS, secureKeyValue } from '../secureKeyValue';
import { createTokenStore } from '../tokenStore';
import { memoryKv } from '../../testing/fakes';

const mocked = SecureStore as jest.Mocked<typeof SecureStore> & { __items: Map<string, string> };

describe('token storage (SecureStore only)', () => {
  beforeEach(() => mocked.__items.clear());

  it('writes each secret as its own SecureStore item with THIS_DEVICE_ONLY accessibility', async () => {
    const store = createTokenStore(secureKeyValue);
    await store.save({
      accessToken: 'A',
      refreshToken: 'R',
      accessExpiresAt: 123,
      deviceSessionId: 'd1',
    });
    expect(mocked.setItemAsync).toHaveBeenCalledTimes(3);
    for (const call of mocked.setItemAsync.mock.calls) {
      expect(call[2]).toEqual({ keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' });
    }
    expect(mocked.__items.get(SECURE_KEYS.accessToken)).toBe('A');
    expect(mocked.__items.get(SECURE_KEYS.refreshToken)).toBe('R');
    expect(JSON.parse(mocked.__items.get(SECURE_KEYS.sessionMeta)!)).toEqual({
      accessExpiresAt: 123,
      deviceSessionId: 'd1',
    });
  });

  it('saves the refresh token first (a crash never pairs a new access token with a rotated refresh token)', async () => {
    await createTokenStore(secureKeyValue).save({
      accessToken: 'A',
      refreshToken: 'R',
      accessExpiresAt: 1,
      deviceSessionId: null,
    });
    expect(mocked.setItemAsync.mock.calls[0]![0]).toBe(SECURE_KEYS.refreshToken);
  });

  it('round-trips, and clear() removes every session item', async () => {
    const store = createTokenStore(secureKeyValue);
    await store.save({
      accessToken: 'A',
      refreshToken: 'R',
      accessExpiresAt: 99,
      deviceSessionId: 'd1',
    });
    await expect(store.load()).resolves.toEqual({
      accessToken: 'A',
      refreshToken: 'R',
      accessExpiresAt: 99,
      deviceSessionId: 'd1',
    });
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
    expect(mocked.__items.size).toBe(0);
  });

  it('treats corrupt metadata as an expired access token (refresh token decides)', async () => {
    const kv = memoryKv();
    kv.items.set(SECURE_KEYS.refreshToken, 'R');
    kv.items.set(SECURE_KEYS.sessionMeta, '{not json');
    await expect(createTokenStore(kv).load()).resolves.toEqual({
      refreshToken: 'R',
      accessToken: '',
      accessExpiresAt: 0,
      deviceSessionId: null,
    });
  });

  it('no refresh token means no session', async () => {
    const kv = memoryKv();
    kv.items.set(SECURE_KEYS.accessToken, 'A');
    await expect(createTokenStore(kv).load()).resolves.toBeNull();
  });

  it('keeps one descriptive installation id per install', async () => {
    const kv = memoryKv();
    const a = await getInstallationId(kv, () => 'id-1');
    const b = await getInstallationId(kv, () => 'id-2');
    expect([a, b]).toEqual(['id-1', 'id-1']);
  });
});
