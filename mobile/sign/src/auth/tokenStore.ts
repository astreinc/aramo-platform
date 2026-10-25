// Session tokens at rest: SecureStore only, one item per secret (keeps each value well
// under platform item-size limits). Nothing here is ever logged.
import { SECURE_KEYS, type SecureKeyValue } from './secureKeyValue';

export interface StoredSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  readonly accessExpiresAt: number;
  /** Server-owned device session id (`dsid`, M-A1 §3.6); descriptive on the client. */
  readonly deviceSessionId: string | null;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

interface Meta {
  readonly accessExpiresAt: number;
  readonly deviceSessionId: string | null;
}

export function createTokenStore(kv: SecureKeyValue): TokenStore {
  return {
    async load() {
      const [refreshToken, accessToken, metaRaw] = await Promise.all([
        kv.getItem(SECURE_KEYS.refreshToken),
        kv.getItem(SECURE_KEYS.accessToken),
        kv.getItem(SECURE_KEYS.sessionMeta),
      ]);
      if (!refreshToken) return null;
      let meta: Meta = { accessExpiresAt: 0, deviceSessionId: null };
      try {
        const parsed = JSON.parse(metaRaw ?? '{}') as Partial<Meta>;
        meta = {
          accessExpiresAt: typeof parsed.accessExpiresAt === 'number' ? parsed.accessExpiresAt : 0,
          deviceSessionId:
            typeof parsed.deviceSessionId === 'string' ? parsed.deviceSessionId : null,
        };
      } catch {
        // Corrupt metadata: treat the access token as expired; the refresh token decides.
      }
      return { refreshToken, accessToken: accessToken ?? '', ...meta };
    },
    async save(s) {
      // Refresh token first: a crash mid-save must never leave a newer access token
      // paired with an already-rotated (revoked) refresh token.
      await kv.setItem(SECURE_KEYS.refreshToken, s.refreshToken);
      await kv.setItem(SECURE_KEYS.accessToken, s.accessToken);
      await kv.setItem(
        SECURE_KEYS.sessionMeta,
        JSON.stringify({ accessExpiresAt: s.accessExpiresAt, deviceSessionId: s.deviceSessionId }),
      );
    },
    async clear() {
      await Promise.all([
        kv.deleteItem(SECURE_KEYS.refreshToken),
        kv.deleteItem(SECURE_KEYS.accessToken),
        kv.deleteItem(SECURE_KEYS.sessionMeta),
      ]);
    },
  };
}
