// Aramo Sign Mobile — the notification vocabulary (Aramo-Sign-Unified-Product-
// Amendment-M-A3-Mobile-Owned-Data-Contracts-v1_0-LOCKED §1, §2; directive §8).
//
// Feed types, the preference flag that governs each type's push, and the push
// text. The push text is GENERIC by default ("A document needs your signature" /
// "An agreement was updated"); the envelope subject and the actor's name appear
// only when the user opted in to `lock_screen_subject`. A push never carries a
// capability token, a link or document content (see PushData for its data).

export const SIGN_NOTIFICATION_TYPES = ['SIGNED', 'VIEWED', 'DECLINED', 'SIGNATURE_NEEDED', 'COMPLETED', 'EXPIRED', 'REMINDER'] as const;
export type SignNotificationType = (typeof SIGN_NOTIFICATION_TYPES)[number];

export type SignNotificationAudience = 'SENDER' | 'RECIPIENT';

export interface SignNotificationPreferences {
  signed: boolean;
  viewed: boolean;
  declined: boolean;
  signature_needed: boolean;
  reminders: boolean;
  lock_screen_subject: boolean;
}

// Defaults: every push type on, the subject on the lock screen OFF (M-A3 §2).
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<SignNotificationPreferences> = Object.freeze({
  signed: true,
  viewed: true,
  declined: true,
  signature_needed: true,
  reminders: true,
  lock_screen_subject: false,
});

export const PREFERENCE_FLAGS = ['signed', 'viewed', 'declined', 'signature_needed', 'reminders'] as const;
export type PreferenceFlag = (typeof PREFERENCE_FLAGS)[number];

// The preference that governs a type's push. COMPLETED rides `signed` (the handoff's
// "Someone signs … is complete"). EXPIRED has no switch of its own: it is pushed
// whenever push is on for the device (the feed row is always written).
export function preferenceFlagFor(type: SignNotificationType): PreferenceFlag | null {
  switch (type) {
    case 'SIGNED':
    case 'COMPLETED':
      return 'signed';
    case 'VIEWED':
      return 'viewed';
    case 'DECLINED':
      return 'declined';
    case 'SIGNATURE_NEEDED':
      return 'signature_needed';
    case 'REMINDER':
      return 'reminders';
    case 'EXPIRED':
      return null;
  }
}

export function pushAllowedByPreferences(type: SignNotificationType, prefs: SignNotificationPreferences): boolean {
  const flag = preferenceFlagFor(type);
  return flag === null ? true : prefs[flag];
}

export const GENERIC_SIGNATURE_TEXT = 'A document needs your signature';
export const GENERIC_UPDATE_TEXT = 'An agreement was updated';
export const PUSH_APP_TITLE = 'Aramo Sign';

export interface PushText {
  title: string;
  body: string;
}

export interface PushTextInput {
  type: SignNotificationType;
  envelope_subject: string;
  actor_name: string | null;
}

const MAX_PUSH_FIELD = 120;
const clip = (s: string): string => (s.length > MAX_PUSH_FIELD ? `${s.slice(0, MAX_PUSH_FIELD - 1)}…` : s);

// The lock-screen text. Generic unless the user opted in to showing the subject.
export function pushTextFor(n: PushTextInput, lockScreenSubject: boolean): PushText {
  const needsSignature = n.type === 'SIGNATURE_NEEDED' || n.type === 'REMINDER';
  if (!lockScreenSubject) {
    return { title: PUSH_APP_TITLE, body: needsSignature ? GENERIC_SIGNATURE_TEXT : GENERIC_UPDATE_TEXT };
  }
  const actor = n.actor_name !== null && n.actor_name.trim() !== '' ? clip(n.actor_name.trim()) : null;
  const subject = clip(n.envelope_subject);
  switch (n.type) {
    case 'SIGNED':
      return { title: actor !== null ? `${actor} signed` : 'Signed', body: subject };
    case 'VIEWED':
      return { title: actor !== null ? `${actor} viewed` : 'Viewed', body: subject };
    case 'DECLINED':
      return { title: actor !== null ? `${actor} declined` : 'Declined', body: subject };
    case 'COMPLETED':
      return { title: 'Everyone signed', body: subject };
    case 'EXPIRED':
      return { title: 'Link expired', body: subject };
    case 'SIGNATURE_NEEDED':
      return { title: 'Waiting for your signature', body: subject };
    case 'REMINDER':
      return { title: 'Your signature is still needed', body: subject };
  }
}

// The push data: exactly { type, envelope_id } for the sender's own envelope. A
// recipient's item carries { type, inbox_item_id } instead: the sender tenant's
// envelope id is never disclosed to a recipient (Permission Contract §4.6).
export type PushData = { type: SignNotificationType; envelope_id: string } | { type: SignNotificationType; inbox_item_id: string };
