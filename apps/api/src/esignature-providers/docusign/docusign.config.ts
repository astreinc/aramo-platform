// DocuSign app registration for this environment. All five values are required;
// with any missing the adapter is not registered (the provider reads "not
// available"). No production values are configured by this program (directive:
// no production external-provider activation without separate approval).
export interface DocuSignConfig {
  readonly integrationKey: string;
  readonly clientSecret: string;
  /** https://account-d.docusign.com (developer) or https://account.docusign.com */
  readonly oauthBaseUrl: string;
  readonly redirectUri: string;
  readonly connectHmacKey: string;
}

export function docuSignConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DocuSignConfig | null {
  const integrationKey = env['DOCUSIGN_INTEGRATION_KEY'];
  const clientSecret = env['DOCUSIGN_CLIENT_SECRET'];
  const oauthBaseUrl = env['DOCUSIGN_OAUTH_BASE_URL'];
  const redirectUri = env['DOCUSIGN_REDIRECT_URI'];
  const connectHmacKey = env['DOCUSIGN_CONNECT_HMAC_KEY'];
  if (!integrationKey || !clientSecret || !oauthBaseUrl || !redirectUri || !connectHmacKey) return null;
  return { integrationKey, clientSecret, oauthBaseUrl: oauthBaseUrl.replace(/\/+$/, ''), redirectUri, connectHmacKey };
}
