// The navigation map (handoff §2), typed. Route params never carry capability tokens:
// guest signing receives an opaque vault handle (links/guestTokenVault.ts).
import type { NavigatorScreenParams } from '@react-navigation/native';

import type { SendStep } from '../state/draftStore';

/** Agreements status chips (M-A4 §3.1); 'done' is labelled "Completed" (all end statuses). */
export type AgreementsFilter = 'all' | 'needs_me' | 'waiting' | 'drafts' | 'done';
/** Last-activity window, applied on the device over the loaded rows (M-A4 §3.2). */
export type AgreementsRange = '30d' | '6m' | '12m' | 'all';
/** How the Send flow was opened from the + button (M-A4 §1.3). 'self' needs FEATURES.selfSign. */
export type SendFlowIntent = 'request' | 'self';
export type EnvelopeDetailTab = 'recipients' | 'documents' | 'activity';

/**
 * The two root tabs (M-A4 §1.1). Search: the shared top bar's search pill on Home calls
 * features/shell/searchFocus.ts `requestSearchFocus()` and switches to Agreements, which
 * consumes the request on focus and focuses its search field.
 */
export type MainTabParamList = {
  Home: undefined;
  Agreements: { filter?: AgreementsFilter; range?: AgreementsRange } | undefined;
};

export type RootStackParamList = {
  /** Signed out. */
  SignIn: undefined;
  Unlock: undefined;
  /** Signed in: the two tabs (Home · Agreements). */
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  /** Side-menu stack screens with a "‹ Home" back link (M-A4 §1.5). */
  Notifications: undefined;
  /** `section: 'settings'` opens Account scrolled to its settings (side menu "Settings"). */
  Account: { section?: 'settings' } | undefined;
  /** Templates list (M-A4 §6.4); the side-menu item shows only while sign.templates is available. */
  Templates: undefined;
  EnvelopeDetail: { envelopeId: string; initialTab?: EnvelopeDetailTab };
  /**
   * Signing a claimed inbox envelope (consent -> fields -> signed). `envelopeId` is the
   * INBOX ITEM id (GET /v1/sign/inbox `id`): the inbox never exposes the sender's
   * envelope id (directive §4.6), and POST /v1/sign/inbox/{id}/sign takes the item id.
   */
  Signing: { envelopeId: string };
  /** A received (claimed) envelope: only what the inbox item returns (C-6, §4.6). */
  ReceivedEnvelope: { inboxItemId: string };
  /** Read-only pages: a sender document's source, or the executed copy / certificate. */
  DocumentViewer: {
    envelopeId: string;
    documentId?: string;
    kind?: 'source' | 'executed' | 'certificate';
  };
  /** New envelope or "Continue editing" a draft, at a step. */
  SendFlow:
    | { localDraftId?: string; envelopeId?: string; step?: SendStep; intent?: SendFlowIntent }
    | undefined;
  /**
   * Signing from an emailed /s/ or /d/ link; available signed in OR signed out.
   * `origin: 'self'` = "Sign a document" (M-A5 §4): the handle holds a SELF session
   * token (never claimable into the inbox, §5), and Done opens the sent envelope.
   */
  GuestSigning: {
    handle: string;
    mode: 'sign' | 'download';
    origin?: 'link' | 'self';
    envelopeId?: string;
  };
  /**
   * Locked hosted (in-person) signing (M-A5 §3.3). `handle` is an opaque vault handle
   * for the HOSTED session token (never the token); `expiresAt` is the session's end.
   */
  HostedSigning: { handle: string; signerName: string; envelopeId: string; expiresAt: string };
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
