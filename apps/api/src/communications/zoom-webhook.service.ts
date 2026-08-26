import { Injectable, Logger } from '@nestjs/common';
import {
  CommunicationInvalidStateError,
  CommunicationsRepository,
  CommunicationsService,
  VoiceProviderRegistry,
  ZoomUnsupportedWebhookEventError,
  computeZoomUrlValidationResponse,
  parseZoomWebhookEnvelope,
  verifyZoomWebhookSignature,
} from '@aramo/communications';
import { IntegrationConnectionService } from '@aramo/integration';

import { ZoomWebhookSecretResolver } from './zoom-webhook-secret.resolver.js';
import {
  ZOOM_WEBHOOK_PROVIDER_KEY,
  ZOOM_WEBHOOK_TOLERANCE_SEC,
} from './zoom-webhook.constants.js';

// COMM-B6 — apps/api Zoom webhook ingress processing. Implements the LOCKED
// anti-oracle flow. Tenant is resolved ONLY after cryptographic authenticity is
// established, from the SIGNED account identity (never a client-supplied tenant).
// No raw Zoom payload is persisted (the inbox holds normalized facts + an opaque
// reference). Update-only: a webhook may UPDATE a known outbound interaction; it
// NEVER creates one. Unknown/unmatched/unsupported events are durably accounted
// for in the inbox (or accepted no-op when no tenant can be trusted) but never
// manufacture an ATS record.
//
//   secret-ref resolvable?            no  -> 503 (dark by construction)
//   timestamp + signature valid+fresh? no -> 401 (uniform; no reason leak)
//   endpoint.url_validation?          yes -> 200 challenge (no inbox, no mutation)
//   body parseable?                    no -> 400
//   resolve connection by signed acct  no -> 204 no-op (no existence oracle)
//   reserve inbox (idempotent)        dup -> 204 no-op
//   normalizeWebhook()        unsupported -> inbox 'ignored', 204
//   correlate by provider ids   unmatched -> inbox 'ignored', 204 (NO mutation)
//   legal transition?                  no -> inbox 'failed', 204 (NO mutation)
//   matched + legal                       -> transition + inbox 'processed', 204

export interface ZoomWebhookInput {
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signatureHeader: string;
  readonly nowEpochSec: number;
}

export interface ZoomWebhookOutcome {
  readonly status: number;
  readonly body?: unknown;
}

@Injectable()
export class ZoomWebhookService {
  private readonly logger = new Logger(ZoomWebhookService.name);

  constructor(
    private readonly secretResolver: ZoomWebhookSecretResolver,
    private readonly connections: IntegrationConnectionService,
    private readonly providers: VoiceProviderRegistry,
    private readonly repo: CommunicationsRepository,
    private readonly comms: CommunicationsService,
  ) {}

  async process(input: ZoomWebhookInput): Promise<ZoomWebhookOutcome> {
    // 1) Secret-ref resolvable? (fail-closed, dark by construction)
    const secret = await this.secretResolver.resolve();
    if (secret === null) {
      return { status: 503 };
    }

    // 2) Signature + freshness — uniform 401 on any failure (no reason oracle).
    const sig = verifyZoomWebhookSignature({
      rawBody: input.rawBody,
      timestamp: input.timestamp,
      signatureHeader: input.signatureHeader,
      secret,
      nowEpochSec: input.nowEpochSec,
      toleranceSec: ZOOM_WEBHOOK_TOLERANCE_SEC,
    });
    if (!sig.ok) {
      return { status: 401 };
    }

    // Only AFTER authenticity: parse the (trusted) body.
    const envelope = parseZoomWebhookEnvelope(input.rawBody);
    if (envelope === null) {
      return { status: 400 };
    }

    // 3) endpoint.url_validation — challenge response, NO inbox, NO mutation.
    if (envelope.event === 'endpoint.url_validation') {
      if (envelope.plain_token === null) {
        return { status: 400 };
      }
      return { status: 200, body: computeZoomUrlValidationResponse(envelope.plain_token, secret) };
    }

    // 4) Trusted tenant/connection resolution from the SIGNED account identity.
    if (envelope.account_id === null) {
      return { status: 204 };
    }
    const connection = await this.connections.findConnectionByProviderAccountId(
      ZOOM_WEBHOOK_PROVIDER_KEY,
      envelope.account_id,
    );
    if (connection === null) {
      // No usable connection for this account → accept + no-op (no oracle).
      return { status: 204 };
    }

    // 5) Reserve the idempotent inbox row (dedup BEFORE any mutation work).
    const reservation = await this.repo.recordProviderEvent({
      tenant_id: connection.tenant_id,
      integration_connection_id: connection.id,
      provider_event_key: envelope.provider_event_key,
      event_type: envelope.event,
    });
    if (!reservation.reserved) {
      // Redelivery — the original event already stands. No re-processing.
      return { status: 204 };
    }

    // 6) Normalize; unsupported event types are recorded ignored (no mutation).
    let normalized;
    try {
      const adapter = this.providers.resolve(ZOOM_WEBHOOK_PROVIDER_KEY);
      if (adapter === undefined || adapter === null) {
        await this.repo.markProviderEventProcessed(reservation.row.id, {
          status: 'ignored',
          error_code: 'PROVIDER_NOT_REGISTERED',
        });
        return { status: 204 };
      }
      normalized = await adapter.normalizeWebhook(envelope);
    } catch (err) {
      if (err instanceof ZoomUnsupportedWebhookEventError) {
        await this.repo.markProviderEventProcessed(reservation.row.id, { status: 'ignored' });
        this.log(connection.tenant_id, envelope.event, 'unsupported');
        return { status: 204 };
      }
      throw err;
    }

    // 7) Correlate by provider ids in the LOCKED order; unmatched → no mutation.
    const interaction = await this.repo.findInteractionByProviderCorrelation(
      connection.tenant_id,
      connection.id,
      {
        call_element_id: normalized.provider_call_element_id ?? null,
        call_history_uuid: normalized.provider_call_history_uuid ?? null,
        call_id: normalized.provider_call_id ?? null,
      },
    );
    if (interaction === null) {
      await this.repo.markProviderEventProcessed(reservation.row.id, { status: 'ignored' });
      this.log(connection.tenant_id, envelope.event, 'unmatched');
      return { status: 204 };
    }

    // 8) Legal transition using the provider's occurred_at; illegal → recorded
    // failure, no mutation (we accepted the event, we just didn't apply it).
    try {
      await this.comms.transition(connection.tenant_id, interaction.id, normalized.target_status, {
        at: normalized.occurred_at,
        ...(normalized.provider_call_id === undefined
          ? {}
          : { provider_call_id: normalized.provider_call_id }),
        ...(normalized.provider_call_history_uuid === undefined
          ? {}
          : { provider_call_history_uuid: normalized.provider_call_history_uuid }),
        ...(normalized.provider_call_element_id === undefined
          ? {}
          : { provider_call_element_id: normalized.provider_call_element_id }),
      });
    } catch (err) {
      if (err instanceof CommunicationInvalidStateError) {
        await this.repo.markProviderEventProcessed(reservation.row.id, {
          status: 'failed',
          interaction_id: interaction.id,
          error_code: 'ILLEGAL_TRANSITION',
        });
        this.log(connection.tenant_id, envelope.event, 'illegal_transition');
        return { status: 204 };
      }
      throw err;
    }

    await this.repo.markProviderEventProcessed(reservation.row.id, {
      status: 'processed',
      interaction_id: interaction.id,
    });
    this.log(connection.tenant_id, envelope.event, 'processed');
    return { status: 204 };
  }

  /** Observability without leaking secret/PII/raw payload. */
  private log(tenantId: string, eventType: string, disposition: string): void {
    this.logger.log(
      `zoom_webhook tenant=${tenantId} event=${eventType} disposition=${disposition}`,
    );
  }
}
