// The navigation map (handoff §2), typed. Route params never carry capability tokens:
// guest signing receives an opaque vault handle (links/guestTokenVault.ts).
import type { NavigatorScreenParams } from '@react-navigation/native';

import type { SendStep } from '../state/draftStore';

export type AgreementsFilter = 'needs_me' | 'waiting' | 'drafts' | 'done';
export type EnvelopeDetailTab = 'recipients' | 'documents' | 'activity';

export type MainTabParamList = {
  Agreements: { filter?: AgreementsFilter } | undefined;
  Notifications: undefined;
  Account: undefined;
};

export type RootStackParamList = {
  /** Signed out. */
  SignIn: undefined;
  Unlock: undefined;
  /** Signed in: the three tabs. */
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
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
  SendFlow: { localDraftId?: string; envelopeId?: string; step?: SendStep } | undefined;
  /** Signing from an emailed /s/ or /d/ link; available signed in OR signed out. */
  GuestSigning: { handle: string; mode: 'sign' | 'download' };
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
