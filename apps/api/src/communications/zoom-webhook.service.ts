import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { PipelineRepository } from '@aramo/pipeline';

import { ZoomWebhookSecretResolver } from './zoom-webhook-secret.resolver.js';
import {
  ZOOM_WEBHOOK_PROVIDER_KEY,
  ZOOM_WEBHOOK_TOLERANCE_SEC,
} from './zoom-webhook.constants.js';
import {
  ZOOM_TRANSCRIPT_EVENT_HANDLER,
  type ZoomTranscriptEventHandler,
} from './zoom-transcript-event-handler.port.js';

// CI-B5Z — the official recording-transcript availability event. Routed to the
// CI transcript-acquisition handler through this SAME governed ingress (after
// signature verification + idempotent inbox reservation); it never bypasses the
// CommunicationProviderEvent inbox and never creates a second event table.
const ZOOM_RECORDING_TRANSCRIPT_COMPLETED_EVENT = 'phone.recording_transcript_completed';

// Recruiting-Journey §8 — the call-interaction states that constitute a PROVIDER-
// VERIFIED two-way conversation. On reaching either, the bound Pipeline advances to
// talent_responded through the CANONICAL response-evidence seam (reconcileForward) —
// the same path recruiter-attested responses use. No special Pipeline mechanism.
const ZOOM_TWO_WAY_STATES: ReadonlySet<string> = new Set(['connected', 'completed']);

// A fixed system principal for connector-driven governed commands (audit-stable).
const ZOOM_WEBHOOK_SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-0000000000c2';

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
    // Recruiting-Journey §8 — composition-root read/act into Pipeline for the
    // two-way → talent_responded convergence (PipelineRepository). apps/api edge only;
    // NO libs/communications → pipeline dependency.
    private readonly pipelines: PipelineRepository,
    // CI-B5Z — optional: bound when the Conversation-Intelligence composition
    // module is present. Unbound → transcript events are recorded `ignored`.
    @Optional()
    @Inject(ZOOM_TRANSCRIPT_EVENT_HANDLER)
    private readonly transcriptHandler: ZoomTranscriptEventHandler | null = null,
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

    // 5b) CI-B5Z recording-transcript route — the event is already in the
    // canonical inbox; hand it to the CI transcript-acquisition handler. On a
    // retriable outcome (e.g. transcript arrived before interaction correlation)
    // the inbox row is recorded `failed` so it stays re-drivable; otherwise
    // `processed`. Handler errors never surface transcript content.
    if (envelope.event === ZOOM_RECORDING_TRANSCRIPT_COMPLETED_EVENT) {
      if (this.transcriptHandler === null) {
        await this.repo.markProviderEventProcessed(reservation.row.id, {
          status: 'ignored',
          error_code: 'CI_TRANSCRIPT_HANDLER_UNBOUND',
        });
        return { status: 204 };
      }
      try {
        const outcome = await this.transcriptHandler.handle({
          tenant_id: connection.tenant_id,
          integration_connection_id: connection.id,
          correlation: envelope.object,
          raw_body: input.rawBody,
        });
        await this.repo.markProviderEventProcessed(reservation.row.id, {
          status: outcome.retriable ? 'failed' : 'processed',
        });
      } catch {
        await this.repo.markProviderEventProcessed(reservation.row.id, {
          status: 'failed',
          error_code: 'CI_TRANSCRIPT_HANDLER_ERROR',
        });
      }
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

    // 9) Recruiting-Journey §8 — a PROVIDER-VERIFIED two-way conversation advances the
    // bound Pipeline to talent_responded through the CANONICAL response-evidence seam
    // (reconcileForward), grounded on THIS provider interaction. SAME path as
    // recruiter-attested responses — no special Pipeline mechanism. Best-effort: the
    // interaction evidence is already durable, so any Pipeline anomaly (no binding,
    // CAS conflict, concealment) is logged + swallowed, never failing the webhook.
    if (ZOOM_TWO_WAY_STATES.has(normalized.target_status)) {
      await this.maybeAdvanceResponded(connection.tenant_id, interaction.id);
    }

    await this.repo.markProviderEventProcessed(reservation.row.id, {
      status: 'processed',
      interaction_id: interaction.id,
    });
    this.log(connection.tenant_id, envelope.event, 'processed');
    return { status: 204 };
  }

  // Recruiting-Journey §8 — resolve the bound Pipeline from the interaction's
  // association and reconcile it FORWARD to talent_responded through the canonical
  // evidence command (provider-verified provenance). Forward-only + idempotent (a
  // `completed` after `connected` is a no-op). Never throws.
  private async maybeAdvanceResponded(tenantId: string, interactionId: string): Promise<void> {
    try {
      const pipelineId = await this.repo.findAssociatedPipelineId(tenantId, interactionId);
      if (pipelineId === null) return;
      await this.pipelines.reconcileForward({
        tenant_id: tenantId,
        id: pipelineId,
        target: 'talent_responded',
        changed_by_id: ZOOM_WEBHOOK_SYSTEM_ACTOR_ID,
        requestId: `zoom-twoway-${interactionId}`,
        visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: interactionId },
      });
    } catch (err) {
      this.logger.warn(
        `zoom_webhook.responded_orchestration_skipped tenant=${tenantId} interaction=${interactionId} reason=${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /** Observability without leaking secret/PII/raw payload. */
  private log(tenantId: string, eventType: string, disposition: string): void {
    this.logger.log(
      `zoom_webhook tenant=${tenantId} event=${eventType} disposition=${disposition}`,
    );
  }
}
