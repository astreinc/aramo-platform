// DocuSign app registration for this environment. The integration key, secret,
// OAuth base, redirect URI and public webhook URL are required; with any missing
// the adapter is not registered (the provider reads "not available"). No
// production values are configured by this program (directive: no production
// external-provider activation without separate approval).
//
// Completion callbacks are requested PER ENVELOPE (eventNotification → webhookUrl),
// so no tenant configures Connect in their own DocuSign account. The Connect HMAC
// key is optional: it applies only to an Aramo-account Connect configuration.
export interface DocuSignConfig {
  readonly integrationKey: string;
  readonly clientSecret: string;
  /** https://account-d.docusign.com (developer) or https://account.docusign.com */
  readonly oauthBaseUrl: string;
  readonly redirectUri: string;
  /** Public HTTPS URL of POST /v1/webhooks/esignature/docusign. */
  readonly webhookUrl: string;
  readonly connectHmacKey: string | null;
}

export function docuSignConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DocuSignConfig | null {
  const integrationKey = env['DOCUSIGN_INTEGRATION_KEY'];
  const clientSecret = env['DOCUSIGN_CLIENT_SECRET'];
  const oauthBaseUrl = env['DOCUSIGN_OAUTH_BASE_URL'];
  const redirectUri = env['DOCUSIGN_REDIRECT_URI'];
  const webhookUrl = env['DOCUSIGN_WEBHOOK_URL'];
  const connectHmacKey = env['DOCUSIGN_CONNECT_HMAC_KEY'];
  if (!integrationKey || !clientSecret || !oauthBaseUrl || !redirectUri || !webhookUrl) return null;
  return {
    integrationKey,
    clientSecret,
    oauthBaseUrl: oauthBaseUrl.replace(/\/+$/, ''),
    redirectUri,
    webhookUrl,
    connectHmacKey: connectHmacKey !== undefined && connectHmacKey.length > 0 ? connectHmacKey : null,
  };
}
