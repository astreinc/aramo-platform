// Push preferences (handoff §4.8/§4.9; directive §8; M-A3 §2):
//   GET/PUT /v1/sign/me/notification-preferences — all six fields on every PUT.
// The server filters pushes by these; the device never filters. "Show subject on lock
// screen" is off by default (generic lock-screen text).
import type { SignPaths } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type NotificationPreferences = NonNullable<
  SignPaths['/v1/sign/me/notification-preferences']['get']['responses'][200]['content']['application/json']
>;
export type PreferenceKey = keyof NotificationPreferences;

/** Server defaults (M-A3 §2): pushes on, subject hidden on the lock screen. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  signed: true,
  viewed: true,
  declined: true,
  signature_needed: true,
  reminders: true,
  lock_screen_subject: false,
};

export const PREFERENCE_ROWS: readonly { key: PreferenceKey; title: string; subtitle?: string }[] =
  [
    { key: 'signed', title: 'Someone signs', subtitle: 'Includes when everyone has signed' },
    { key: 'viewed', title: 'Someone opens an envelope' },
    { key: 'declined', title: 'Someone declines' },
    { key: 'signature_needed', title: 'Your signature is needed' },
    { key: 'reminders', title: 'Reminders to sign' },
    {
      key: 'lock_screen_subject',
      title: 'Show subject on lock screen',
      subtitle:
        'Off: notifications say “A document needs your signature” or “An agreement was updated”.',
    },
  ];

/** The full PUT body with one switch changed (the route replaces all six fields). */
export function withPreference(
  current: NotificationPreferences,
  key: PreferenceKey,
  value: boolean,
): NotificationPreferences {
  return {
    signed: current.signed,
    viewed: current.viewed,
    declined: current.declined,
    signature_needed: current.signature_needed,
    reminders: current.reminders,
    lock_screen_subject: current.lock_screen_subject,
    [key]: value,
  };
}

export async function loadPreferences(
  workspace: WorkspaceClient,
): Promise<NotificationPreferences> {
  return workspace.call('/v1/sign/me/notification-preferences', 'get', {});
}

export async function savePreferences(
  workspace: WorkspaceClient,
  body: NotificationPreferences,
): Promise<NotificationPreferences> {
  return workspace.call('/v1/sign/me/notification-preferences', 'put', { body });
}
