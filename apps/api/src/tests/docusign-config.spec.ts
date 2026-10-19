import { describe, expect, it } from 'vitest';

import { docuSignConfigFromEnv } from '../esignature-providers/docusign/docusign.config.js';

const BASE = {
  DOCUSIGN_INTEGRATION_KEY: 'ik',
  DOCUSIGN_CLIENT_SECRET: 's',
  DOCUSIGN_OAUTH_BASE_URL: 'https://account-d.docusign.com/',
  DOCUSIGN_REDIRECT_URI: 'http://localhost:4205/v1/integrations/esignature/docusign/callback',
  DOCUSIGN_WEBHOOK_URL: 'https://tunnel.example/v1/webhooks/esignature/docusign',
};

describe('docuSignConfigFromEnv', () => {
  it('needs the app registration and the public webhook URL; the Connect HMAC key is optional', () => {
    expect(docuSignConfigFromEnv(BASE)).toEqual({
      integrationKey: 'ik',
      clientSecret: 's',
      oauthBaseUrl: 'https://account-d.docusign.com',
      redirectUri: BASE.DOCUSIGN_REDIRECT_URI,
      webhookUrl: BASE.DOCUSIGN_WEBHOOK_URL,
      connectHmacKey: null,
    });
    expect(docuSignConfigFromEnv({ ...BASE, DOCUSIGN_CONNECT_HMAC_KEY: 'k' })?.connectHmacKey).toBe('k');
  });

  it('is not configured (provider not available) when a required value is missing', () => {
    const { DOCUSIGN_WEBHOOK_URL: _omit, ...noWebhook } = BASE;
    expect(docuSignConfigFromEnv(noWebhook)).toBeNull();
    expect(docuSignConfigFromEnv({})).toBeNull();
  });
});
