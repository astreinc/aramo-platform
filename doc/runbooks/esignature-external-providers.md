# External e-signature providers (DocuSign, Adobe Acrobat Sign)

Governing: `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md` §E–§G;
addendum `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md` (A1-17…).

**Production activation is NOT authorized.** None of these variables are set in
`docker-compose.prod.yml`; without them the provider reads "Not available yet" and
its webhook answers 503.

## DocuSign (developer account → local)
1. In the DocuSign developer account create an app (integration key) with
   Authorization Code Grant, a secret key, and the redirect URI
   `http://localhost:3000/v1/integrations/esignature/docusign/callback`
   (production: `https://<tenant-host>/v1/integrations/esignature/docusign/callback`).
2. Create a Connect configuration (JSON, REST v2.1) for **Envelope Completed**,
   pointing at `https://<public-tunnel>/v1/webhooks/esignature/docusign`, with HMAC enabled.
3. Set in the api environment:

   | Variable | Value |
   |---|---|
   | `DOCUSIGN_INTEGRATION_KEY` | integration key |
   | `DOCUSIGN_CLIENT_SECRET` | secret key |
   | `DOCUSIGN_OAUTH_BASE_URL` | `https://account-d.docusign.com` |
   | `DOCUSIGN_REDIRECT_URI` | the redirect URI above |
   | `DOCUSIGN_CONNECT_HMAC_KEY` | the Connect HMAC key |

4. Restart the api. Settings → Integrations → E-Signature shows DocuSign with **Connect**.
   Tokens go to the `connector/*` Secrets Manager namespace (`ARAMO_ENV` scoped).

## What to verify in the sandbox (pending — A1-23)
- Connect: OAuth round trip lands on Settings with "DocuSign is connected".
- Select DocuSign, send an RTR; the envelope arrives with a signature tab on the last page.
- Sign it; the webhook stores the signed PDF (EXECUTED) and the Certificate of Completion
  (PROVIDER_COMPLETION_EVIDENCE); the RTR shows signed and the submittal gate passes.
- Reminder resends to the signer; void works on an in-flight envelope.
- Disconnect → sends read "reconnect"; the tenant is not switched to Aramo Sign.
