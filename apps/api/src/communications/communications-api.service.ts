import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  CommunicationsRepository,
  VoiceProviderRegistry,
  encodeZoomCredential,
  ZoomCredentialDecodeError,
  type VoiceCapabilities,
  type ZoomCredentialBundle,
} from '@aramo/communications';
import {
  IntegrationConnectionService,
  type IntegrationConnectionView,
} from '@aramo/integration';

import type {
  CommunicationCapabilitiesDto,
  CommunicationConnectionStatus,
  CommunicationConnectionTestResultDto,
  CommunicationInteractionViewDto,
  CommunicationProviderConfigDto,
  CommunicationProviderIdentityDto,
} from './dto/communications.dto.js';

// COMM-B2/B3 — apps/api orchestration for the Communications/Voice read surface.
// Lives at the composition root (NOT libs/communications) so no
// communications→consent/integration/identity nx edge is created; the tenant→
// provider-connection resolution is a composition-root read into @aramo/integration.
// Reads are tenant-safe: a cross-tenant id is a NOT-FOUND, never an info leak.
//
// COMM-V1 canonical provider key (locked). Kept here (composition root), NOT in
// the neutral communications domain.
const ZOOM_PHONE_PROVIDER_KEY = 'zoom_phone';

// COMM-C1 — the communication provider keys this slice administers. Vendor keys
// live at the composition root ONLY; the neutral communications domain never
// learns them. PR-1 is Zoom-only (directive R1); this list is the single place a
// future ratified provider would be added.
const COMMUNICATION_PROVIDER_KEYS = [ZOOM_PHONE_PROVIDER_KEY] as const;

// Provider-specific display copy is legal at the composition root (directive
// §4.6): generic contracts stay neutral, but a card may name "Zoom Phone".
const COMMUNICATION_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [ZOOM_PHONE_PROVIDER_KEY]: 'Zoom Phone',
});

@Injectable()
export class CommunicationsApiService {
  constructor(
    private readonly repo: CommunicationsRepository,
    private readonly providers: VoiceProviderRegistry,
    private readonly connections: IntegrationConnectionService,
  ) {}

  /**
   * COMM-B3 — per-tenant capability descriptor. Resolves the tenant's USABLE
   * (configured|active) `zoom_phone` IntegrationConnection, then the registered
   * adapter for that connection's provider_key, and returns THAT adapter's
   * capabilities. NEVER falls back to a default/fake provider. No usable
   * connection (or no registered adapter) -> COMMUNICATION_PROVIDER_NOT_CONFIGURED
   * (409).
   */
  async getCapabilities(tenantId: string, requestId: string): Promise<CommunicationCapabilitiesDto> {
    const connection = await this.connections.findConnectionByProviderKey(
      tenantId,
      ZOOM_PHONE_PROVIDER_KEY,
    );
    const provider =
      connection === null ? null : this.providers.resolve(connection.provider_key);
    if (provider === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }
    const caps = provider.getCapabilities();
    return {
      provider_key: provider.providerKey(),
      capabilities: {
        voice: caps.voice,
        ...(caps.sms === undefined ? {} : { sms: caps.sms }),
        ...(caps.recording === undefined ? {} : { recording: caps.recording }),
        ...(caps.transcript === undefined ? {} : { transcript: caps.transcript }),
      },
    };
  }

  /**
   * The caller's own provider-identity mapping (connection-agnostic in B2). No
   * mapping -> COMMUNICATION_USER_NOT_MAPPED (404).
   */
  async getMyProviderIdentity(
    tenantId: string,
    recruiterId: string,
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    const row = await this.repo.findProviderIdentityByRecruiter(tenantId, recruiterId);
    if (row === null) {
      throw new AramoError(
        'COMMUNICATION_USER_NOT_MAPPED',
        'The caller has no communications provider identity mapping',
        404,
        { requestId },
      );
    }
    return row;
  }

  /**
   * COMM-B3 — admin list of the tenant's provider-identity mappings (on the
   * tenant's zoom_phone connection). Authorized by integration:read. No usable
   * connection -> COMMUNICATION_PROVIDER_NOT_CONFIGURED (409).
   */
  async listProviderIdentities(
    tenantId: string,
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto[]> {
    const connection = await this.requireProviderConnection(tenantId, requestId);
    return this.repo.listProviderIdentitiesForConnection(tenantId, connection.id);
  }

  /**
   * COMM-B3 — admin UPSERT a recruiter's provider-identity mapping on the tenant's
   * zoom_phone connection (intentional bind/rebind). Authorized by integration:write.
   * No usable connection -> 409 COMMUNICATION_PROVIDER_NOT_CONFIGURED. A provider
   * user already claimed by a different recruiter -> 409
   * COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED.
   */
  async upsertProviderIdentity(
    tenantId: string,
    recruiterId: string,
    body: {
      provider_user_id: string;
      provider_extension_id?: string | null;
      display_phone_number?: string | null;
      extension?: string | null;
      voice_enabled?: boolean;
      sms_enabled?: boolean;
      status?: CommunicationProviderIdentityDto['status'];
    },
    requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    const connection = await this.requireProviderConnection(tenantId, requestId);
    try {
      return await this.repo.upsertProviderIdentity({
        tenant_id: tenantId,
        integration_connection_id: connection.id,
        recruiter_id: recruiterId,
        ...body,
      });
    } catch (err) {
      if (isProviderUserUniqueViolation(err)) {
        throw new AramoError(
          'COMMUNICATION_PROVIDER_USER_ALREADY_MAPPED',
          'That provider user is already mapped to a different recruiter on this connection',
          409,
          { requestId, details: { provider_user_id: body.provider_user_id } },
        );
      }
      throw err;
    }
  }

  /** Resolve the tenant's usable zoom_phone connection or 409 PROVIDER_NOT_CONFIGURED. */
  private async requireProviderConnection(
    tenantId: string,
    requestId: string,
  ): Promise<{ id: string; provider_key: string }> {
    const connection = await this.connections.findConnectionByProviderKey(
      tenantId,
      ZOOM_PHONE_PROVIDER_KEY,
    );
    if (connection === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }
    return connection;
  }

  /**
   * COMM-C1 — the tenant's communication provider CONFIGURATION list for Settings
   * → Integrations → Communications. Authorized by integration:read. Unlike
   * getCapabilities (communication:read; 409 when unconfigured), this admin read
   * is tolerant: an un-provisioned provider is returned as `not_configured` so the
   * Settings surface can render it. SECRET-FREE: `credential_configured` reflects
   * whether a credential exists (`has_secret`) but never the value or secret_ref.
   */
  async listProviderConfigurations(tenantId: string): Promise<CommunicationProviderConfigDto[]> {
    const connections = await this.connections.listConnections(tenantId);
    const out: CommunicationProviderConfigDto[] = [];
    for (const providerKey of COMMUNICATION_PROVIDER_KEYS) {
      const adapter = this.providers.resolve(providerKey);
      // An unregistered provider is not offered at all (no fake card).
      if (adapter === null) continue;
      const connection = connections.find((c) => c.provider_key === providerKey) ?? null;
      let mappingCount = 0;
      if (connection !== null) {
        const mappings = await this.repo.listProviderIdentitiesForConnection(
          tenantId,
          connection.id,
        );
        mappingCount = mappings.length;
      }
      out.push(
        buildProviderConfigDto(providerKey, adapter.getCapabilities(), connection, mappingCount),
      );
    }
    return out;
  }

  /**
   * COMM-C1 — configure/update the tenant's Zoom credential (credential-path
   * closure). Authorized by integration:write. The typed bundle is validated +
   * encoded via the Zoom codec, then written through the EXISTING Integration
   * credential path to Secrets Manager; Postgres stores only the opaque
   * secret_ref. No token/secret is persisted here or returned. Provisions the
   * tenant's zoom_phone connection on first configure (no second connection
   * table). Tenant ownership is resolved server-side before any secret write.
   */
  async configureZoomCredential(
    tenantId: string,
    bundle: ZoomCredentialBundle,
    requestId: string,
  ): Promise<CommunicationProviderConfigDto> {
    let encoded: string;
    try {
      // Server-side validate + encode (never trust a client-built opaque string).
      encoded = encodeZoomCredential(bundle);
    } catch (err) {
      if (err instanceof ZoomCredentialDecodeError) {
        throw new AramoError('VALIDATION_ERROR', 'Invalid Zoom credential bundle', 400, {
          requestId,
          details: { field: 'access_token' },
        });
      }
      throw err;
    }

    const existing = await this.connections.listConnections(tenantId);
    let connection =
      existing.find((c) => c.provider_key === ZOOM_PHONE_PROVIDER_KEY) ?? null;
    if (connection === null) {
      connection = await this.connections.createConnection({
        tenant_id: tenantId,
        provider_key: ZOOM_PHONE_PROVIDER_KEY,
        provider_account_id: bundle.account_id ?? null,
      });
    } else if (
      bundle.account_id !== undefined &&
      connection.provider_account_id !== bundle.account_id
    ) {
      // Keep the bound provider account identity in step with the new bundle.
      connection = await this.connections.updateConnection(tenantId, connection.id, {
        provider_account_id: bundle.account_id,
      });
    }

    // Write-only credential set → Secrets Manager (raw value never to Postgres).
    await this.connections.setCredential({
      tenant_id: tenantId,
      id: connection.id,
      credential: encoded,
    });

    // Return the fresh, secret-free configuration view.
    const refreshed = await this.connections.getConnection(tenantId, connection.id);
    const mappings = await this.repo.listProviderIdentitiesForConnection(
      tenantId,
      connection.id,
    );
    const adapter = this.providers.resolve(ZOOM_PHONE_PROVIDER_KEY);
    return buildProviderConfigDto(
      ZOOM_PHONE_PROVIDER_KEY,
      adapter === null ? null : adapter.getCapabilities(),
      refreshed,
      mappings.length,
    );
  }

  /**
   * COMM-C1 — tenant-admin connection test. Authorized by integration:write.
   * Runs the adapter's structural validateConnection (a provider account is
   * bound); it does NOT perform a live external Zoom ping (B8-deferred) and does
   * NOT fake success — the result carries `checked: 'structural'`. No recruiting
   * state is mutated; no secret is echoed. No usable connection -> 409
   * COMMUNICATION_PROVIDER_NOT_CONFIGURED.
   */
  async testProviderConnection(
    tenantId: string,
    requestId: string,
  ): Promise<CommunicationConnectionTestResultDto> {
    const connections = await this.connections.listConnections(tenantId);
    const connection =
      connections.find((c) => c.provider_key === ZOOM_PHONE_PROVIDER_KEY) ?? null;
    const adapter = connection === null ? null : this.providers.resolve(connection.provider_key);
    if (connection === null || adapter === null) {
      throw new AramoError(
        'COMMUNICATION_PROVIDER_NOT_CONFIGURED',
        'No communications provider is configured for this tenant',
        409,
        { requestId },
      );
    }
    const health = await adapter.validateConnection({
      id: connection.id,
      tenant_id: connection.tenant_id,
      provider_key: connection.provider_key,
      provider_account_id: connection.provider_account_id,
    });
    return {
      provider_key: connection.provider_key,
      healthy: health.healthy,
      detail: health.detail ?? null,
      checked: 'structural',
    };
  }

  /** A communication interaction by id, tenant-scoped. Null when absent/cross-tenant. */
  async getInteraction(
    tenantId: string,
    interactionId: string,
  ): Promise<CommunicationInteractionViewDto | null> {
    const row = await this.repo.findInteractionForTenant(tenantId, interactionId);
    if (row === null) return null;
    return {
      id: row.id,
      channel: row.channel,
      direction: row.direction,
      status: row.status,
      integration_connection_id: row.integration_connection_id,
      from_address: row.from_address,
      to_address: row.to_address,
      started_at: row.started_at === null ? null : row.started_at.toISOString(),
      ringing_at: row.ringing_at === null ? null : row.ringing_at.toISOString(),
      connected_at: row.connected_at === null ? null : row.connected_at.toISOString(),
      ended_at: row.ended_at === null ? null : row.ended_at.toISOString(),
      duration_seconds: row.duration_seconds,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

/**
 * True iff `err` is a Prisma unique-constraint violation (P2002). On the mapping
 * upsert the (integration_connection_id, recruiter_id) unique is the upsert TARGET
 * (matched → update), so the only unique that can still fire is
 * (integration_connection_id, provider_user_id). Handles both the standard
 * P2002 code and the Prisma-7/PrismaPg driver-adapter shape (raw violation at
 * driverAdapterError.cause.originalMessage).
 */
/**
 * COMM-C1 — project a communication provider + its (optional) connection into the
 * secret-free admin configuration DTO. `configuration_state` collapses the raw
 * integration lifecycle status into the actionable states the Settings UI shows;
 * a null/`disconnected` connection is `not_configured`. Capabilities carry a
 * per-capability execution posture: voice is executable (call route B5), SMS is
 * declared-only in PR-1 (no send path) — never advertise a Send affordance.
 */
function buildProviderConfigDto(
  providerKey: string,
  capabilities: VoiceCapabilities | null,
  connection: IntegrationConnectionView | null,
  recruiterMappingCount: number,
): CommunicationProviderConfigDto {
  const status = (connection?.status ?? null) as CommunicationConnectionStatus | null;
  const smsSupported = capabilities?.sms !== undefined;
  const voiceSupported =
    capabilities !== null && (capabilities.voice.outbound || capabilities.voice.inbound);
  return {
    provider_key: providerKey,
    display_name: COMMUNICATION_PROVIDER_DISPLAY_NAMES[providerKey] ?? providerKey,
    connection_id: connection?.id ?? null,
    configuration_state: toConfigurationState(status),
    status,
    credential_configured: connection?.has_secret ?? false,
    provider_account_id: connection?.provider_account_id ?? null,
    last_successful_at: connection?.last_successful_at ?? null,
    last_error_code: connection?.last_error_code ?? null,
    recruiter_mapping_count: recruiterMappingCount,
    capabilities: {
      // Voice execution is wired (POST /v1/communications/calls, COMM-B5).
      voice: { supported: voiceSupported, execution: voiceSupported ? 'available' : 'not_available' },
      // SMS is DECLARED by the adapter but has NO send path in PR-1 (directive
      // §4.5): execution is not available in this release.
      sms: { supported: smsSupported, execution: 'not_available' },
    },
  };
}

/** Collapse the integration lifecycle status into the admin actionable state. */
function toConfigurationState(
  status: CommunicationConnectionStatus | null,
): CommunicationProviderConfigDto['configuration_state'] {
  switch (status) {
    case null:
    case 'disconnected':
      return 'not_configured';
    case 'configured':
      return 'configured';
    case 'active':
      return 'active';
    case 'degraded':
      return 'degraded';
    case 'disabled':
      return 'disabled';
  }
}

function isProviderUserUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
  };
  if (e.code === 'P2002') return true;
  const raw = e.meta?.driverAdapterError?.cause?.originalMessage ?? '';
  return raw.includes('provider_user_id');
}
