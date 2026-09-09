// CI-B5Z — production composition bindings for the Zoom transcript token + the
// tenant's Zoom connection secret_ref. Reuses the EXISTING credential custody
// chain (recon): IntegrationConnectionService → deterministic connector
// secret_ref → SECRETS_MANAGER_PORT → decodeZoomCredential. No parallel
// credential store; the token/secret is NEVER persisted, logged, or returned
// beyond the bearer value handed to the bounded HTTP client. Live invocation is
// the gated production step (production Zoom access is not authorized in B5Z);
// construction is inert.

import { Inject, Injectable } from '@nestjs/common';
import {
  IntegrationConnectionService,
  SECRETS_MANAGER_PORT,
  buildConnectorSecretRef,
  type SecretsManagerPort,
} from '@aramo/integration';
import { ZOOM_PHONE_PROVIDER_KEY, decodeZoomCredential } from '@aramo/communications';

import type { ZoomAccessTokenProvider } from './zoom-transcript-http.client.js';
import {
  ZoomConnectionResolutionError,
  type ZoomConnectionSecretResolver,
} from './zoom-recording-transcript.provider.js';

/** Resolves the tenant's zoom_phone connection secret_ref (reuses connector custody). */
@Injectable()
export class IntegrationZoomConnectionSecretResolver implements ZoomConnectionSecretResolver {
  constructor(private readonly connections: IntegrationConnectionService) {}

  async resolveSecretRef(tenantId: string): Promise<string> {
    const conn = await this.connections.findConnectionByProviderKey(tenantId, ZOOM_PHONE_PROVIDER_KEY);
    if (conn === null) {
      throw new ZoomConnectionResolutionError('ZOOM_CONNECTION_NOT_CONFIGURED', false);
    }
    // Deterministic, server-derived ref — never client input (recon §credentials).
    return buildConnectorSecretRef({ tenant_id: tenantId, connection_id: conn.id });
  }
}

/** Resolves a Zoom bearer token from a server-derived secret_ref (decode only). */
@Injectable()
export class SecretsManagerZoomTokenProvider implements ZoomAccessTokenProvider {
  constructor(
    @Inject(SECRETS_MANAGER_PORT) private readonly secrets: SecretsManagerPort,
  ) {}

  async getAccessToken(secretRef: string): Promise<string> {
    const raw = await this.secrets.getSecretValue(secretRef);
    return decodeZoomCredential(raw).access_token;
  }

  /**
   * On 401, re-read the stored bundle (another process may have rotated it).
   * B5Z does NOT mint tokens (production Zoom OAuth is gated) — a still-expired
   * token yields a persistent 401 that the client classifies as terminal.
   */
  async refreshAccessToken(secretRef: string): Promise<string> {
    const raw = await this.secrets.getSecretValue(secretRef);
    return decodeZoomCredential(raw).access_token;
  }
}
