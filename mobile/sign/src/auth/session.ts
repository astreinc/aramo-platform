// The signed-in session: restore from SecureStore, silent refresh (single-flight,
// rotated refresh token), session expiry and sign-out (directive §3.5; M-A1 §3.4-§3.5).
// It implements WorkspaceSessionPort, so the workspace client can refresh on 401.
import { ApiError } from '../api/errors';
import type { WorkspaceSessionPort } from '../api/workspaceClient';
import type { NativeAuthApi, NativeTokenResponse } from './nativeAuthApi';
import type { StoredSession, TokenStore } from './tokenStore';

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';
/** Why the user is signed out: never signed in, chose to, or the session ended. */
export type SignedOutCause = 'none' | 'signedOut' | 'expired';

export interface SessionSnapshot {
  readonly status: SessionStatus;
  readonly cause: SignedOutCause;
  readonly deviceSessionId: string | null;
}

type Listener = (s: SessionSnapshot) => void;
type Hook = () => Promise<void>;

export interface SessionManagerDeps {
  readonly store: TokenStore;
  readonly api: NativeAuthApi;
  readonly now?: () => number;
  /** Refresh this long before the access token expires (default 60 s). */
  readonly refreshSkewMs?: number;
}

export class SessionManager implements WorkspaceSessionPort {
  private snap: SessionSnapshot = { status: 'restoring', cause: 'none', deviceSessionId: null };
  private current: StoredSession | null = null;
  private inflight: Promise<string | null> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly beforeSignOut = new Set<Hook>();
  private readonly now: () => number;
  private readonly skew: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.skew = deps.refreshSkewMs ?? 60_000;
  }

  snapshot = (): SessionSnapshot => this.snap;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Work to run while still authenticated at sign-out (e.g. remove the push device). */
  onBeforeSignOut(hook: Hook): () => void {
    this.beforeSignOut.add(hook);
    return () => this.beforeSignOut.delete(hook);
  }

  private set(next: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }

  async restore(): Promise<void> {
    try {
      this.current = await this.deps.store.load();
    } catch {
      this.current = null;
    }
    this.set(
      this.current
        ? { status: 'signedIn', cause: 'none', deviceSessionId: this.current.deviceSessionId }
        : { status: 'signedOut', cause: 'none', deviceSessionId: null },
    );
  }

  private fromResponse(r: NativeTokenResponse): StoredSession {
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      accessExpiresAt: this.now() + r.expires_in * 1000,
      deviceSessionId: r.device_session_id || this.current?.deviceSessionId || null,
    };
  }

  /** Called once the native code exchange succeeded. */
  async establish(tokens: NativeTokenResponse): Promise<void> {
    const s = this.fromResponse(tokens);
    await this.deps.store.save(s);
    this.current = s;
    this.set({ status: 'signedIn', cause: 'none', deviceSessionId: s.deviceSessionId });
  }

  async getAccessToken(): Promise<string | null> {
    const s = this.current;
    if (!s) return null;
    if (s.accessToken && s.accessExpiresAt - this.skew > this.now()) return s.accessToken;
    return this.refreshAccessToken();
  }

  /**
   * Rotate now. Concurrent callers share ONE request: a second use of the same refresh
   * token would trip the server's reuse detection and revoke the family (M-A1 §3.4).
   * Network or server failures keep the session (the caller sees the error); a refusal
   * (invalid / reused / capability lost) ends it.
   */
  refreshAccessToken(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    const s = this.current;
    if (!s) return Promise.resolve(null);
    this.inflight = (async () => {
      try {
        const next = this.fromResponse(await this.deps.api.refresh(s.refreshToken));
        await this.deps.store.save(next);
        this.current = next;
        return next.accessToken;
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          await this.end('expired');
          return null;
        }
        throw e;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  sessionExpired(): void {
    void this.end('expired');
  }

  async signOut(): Promise<void> {
    const s = this.current;
    for (const hook of this.beforeSignOut) {
      try {
        await hook();
      } catch {
        // Best effort: sign-out always completes locally.
      }
    }
    if (s) {
      try {
        await this.deps.api.logout(s.refreshToken);
      } catch {
        // Offline or already revoked: local credentials are still removed below.
      }
    }
    await this.end('signedOut');
  }

  private async end(cause: SignedOutCause): Promise<void> {
    if (this.snap.status === 'signedOut' && this.current === null) return;
    this.current = null;
    try {
      await this.deps.store.clear();
    } finally {
      this.set({ status: 'signedOut', cause, deviceSessionId: null });
    }
  }
}
