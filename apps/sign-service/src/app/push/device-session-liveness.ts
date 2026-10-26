import { Injectable, Logger } from '@nestjs/common';
import { SignNotificationRepository } from '@aramo/sign';

// Aramo Sign Mobile — is a native device session (M-A1 §3.6, the token's `dsid`)
// still live? auth-service owns the session (auth_storage."NativeDeviceSession");
// revoking it (sign-out, device revoke, refresh-token reuse) must also end its push
// registration (M-A1 §3.6, M-A3 §2). sign-service reads the session state here,
// read-only, from the same database: at registration and again just before every
// push. A session that is revoked, missing, or owned by someone else is not live.
//
// 'unknown' only when the auth_storage table is not present (a database without
// the M-A1 migration, e.g. an isolated sign test database); callers then rely on
// the sign-side revocation alone.

export const DEVICE_SESSION_LIVENESS = 'DEVICE_SESSION_LIVENESS';

export type DeviceSessionState = 'live' | 'revoked' | 'unknown';

export interface DeviceSessionLiveness {
  stateOf(device_session_id: string, owner: { tenant_id: string; user_id: string }): Promise<DeviceSessionState>;
}

const UNDEFINED_TABLE = '42P01';

@Injectable()
export class AuthStorageDeviceSessionLiveness implements DeviceSessionLiveness {
  private readonly log = new Logger('DeviceSessionLiveness');
  private warned = false;

  constructor(private readonly repo: SignNotificationRepository) {}

  async stateOf(device_session_id: string, owner: { tenant_id: string; user_id: string }): Promise<DeviceSessionState> {
    try {
      const s = await this.repo.nativeDeviceSession(device_session_id);
      if (s === null || s.revoked_at !== null) return 'revoked';
      return s.user_id === owner.user_id && s.tenant_id === owner.tenant_id ? 'live' : 'revoked';
    } catch (err) {
      const code = (err as { code?: string; meta?: { code?: string } }).meta?.code ?? (err as { code?: string }).code;
      const message = (err as Error).message ?? '';
      if (code === UNDEFINED_TABLE || message.includes(UNDEFINED_TABLE) || /relation .* does not exist/.test(message)) {
        if (!this.warned) {
          this.warned = true;
          this.log.warn('auth_storage.NativeDeviceSession is not present; device-session state is not checked');
        }
        return 'unknown';
      }
      throw err;
    }
  }
}
