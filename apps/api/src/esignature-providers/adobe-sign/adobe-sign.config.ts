// Adobe Acrobat Sign app registration for this environment. All values required;
// with any missing the adapter is not registered (the provider reads "not
// available"). No production values are configured by this program.
export interface AdobeSignConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The OAuth host the admin signs in on, e.g. https://secure.na1.adobesign.com */
  readonly oauthBaseUrl: string;
  readonly redirectUri: string;
  /** Public URL of POST/GET /v1/webhooks/esignature/adobe-sign, registered at connect time. */
  readonly webhookUrl: string;
}

export function adobeSignConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdobeSignConfig | null {
  const clientId = env['ADOBE_SIGN_CLIENT_ID'];
  const clientSecret = env['ADOBE_SIGN_CLIENT_SECRET'];
  const oauthBaseUrl = env['ADOBE_SIGN_OAUTH_BASE_URL'];
  const redirectUri = env['ADOBE_SIGN_REDIRECT_URI'];
  const webhookUrl = env['ADOBE_SIGN_WEBHOOK_URL'];
  if (!clientId || !clientSecret || !oauthBaseUrl || !redirectUri || !webhookUrl) return null;
  return { clientId, clientSecret, oauthBaseUrl: oauthBaseUrl.replace(/\/+$/, ''), redirectUri, webhookUrl };
}
