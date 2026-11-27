// @aramo/sign-cloud-storage — SIGN-FREE-PARITY-1 S6 (FP-R7): the Sign-scoped cloud storage
// connector (Google Drive, OneDrive personal + work, Dropbox, Box). OAuth 2.0 authorization
// code (+ PKCE where offered) and plain-fetch file clients; no provider SDK.
//
// scope:sign — used by apps/sign-service only. It never imports the ATS Microsoft Graph or
// integration libs (scope:ats): the Sign wall (eslint.config.mjs, scope:sign) stays intact.
// Token storage and encryption live in sign-service (SIGN_CLOUD_TOKEN_KEY); this lib holds
// no secret and keeps no state.

import { BoxClient } from './lib/box.client.js';
import { DropboxClient } from './lib/dropbox.client.js';
import { GoogleDriveClient } from './lib/google-drive.client.js';
import { OneDriveClient } from './lib/onedrive.client.js';
import type { CloudDriveClient, CloudProviderId, FetchLike } from './lib/types.js';

export * from './lib/types.js';
export {
  OAUTH_SPECS,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revokeGrant,
  randomToken,
  sha256Hex,
  pkceChallenge,
  type OAuthProviderSpec,
  type OAuthClientCredentials,
  type TokenSet,
} from './lib/oauth.js';
export { GoogleDriveClient, driveLiteral } from './lib/google-drive.client.js';
export { OneDriveClient } from './lib/onedrive.client.js';
export { DropboxClient, dropboxArg } from './lib/dropbox.client.js';
export { BoxClient, numberedName } from './lib/box.client.js';
export { extensionOf } from './lib/http.js';

/** The files client of one provider, bound to one access token. */
export function cloudDriveClient(provider: CloudProviderId, access_token: string, fetchFn: FetchLike): CloudDriveClient {
  switch (provider) {
    case 'google_drive':
      return new GoogleDriveClient(access_token, fetchFn);
    case 'onedrive':
      return new OneDriveClient(access_token, fetchFn);
    case 'dropbox':
      return new DropboxClient(access_token, fetchFn);
    case 'box':
      return new BoxClient(access_token, fetchFn);
  }
}
