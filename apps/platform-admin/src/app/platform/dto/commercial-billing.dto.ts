import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { BILLING_COMMAND_STATES, BILLING_WEBHOOK_INBOX_STATUSES, type BillingCommandState, type BillingWebhookInboxStatus } from '@aramo/subscription';

// CCP-C1 — GET /platform/commercial/billing-commands and GET /platform/commercial/billing-webhook-inbox
// (platform:billing:read): the operator-visible state of the Stripe command outbox and the webhook
// inbox (Conv. C-22, C-23). READ-ONLY. The query DTOs are the 400-shape gate.

export class BillingCommandQueryDto {
  @IsOptional() @IsIn([...BILLING_COMMAND_STATES]) state?: BillingCommandState;
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsUUID() change_request_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export class BillingWebhookInboxQueryDto {
  @IsOptional() @IsIn([...BILLING_WEBHOOK_INBOX_STATUSES]) status?: BillingWebhookInboxStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export interface BillingCommandDto {
  id: string;
  provider: string;
  command_kind: string;
  // CCP-C7 — exactly one origin: a change request, or a tenant owner's self-service request.
  change_request_id: string | null;
  self_service_request_id: string | null;
  step: string;
  idempotency_key: string;
  tenant_id: string;
  product_key: string;
  target_ref: string;
  params: Record<string, unknown>;
  // PENDING | DISPATCHING | PENDING_PROVIDER | RETRY_WAIT | FAILED | CONFIRMED
  state: string;
  // true until the provider-confirmed state is applied (C-23): never reported committed earlier.
  pending_provider: boolean;
  attempts: number;
  next_attempt_at: string | null;
  failure: { code: string; detail: string | null } | null;
  last_detail: string | null;
  provider_accepted_at: string | null;
  confirmed_at: string | null;
  confirmation_source: string | null;
  confirmation_event_id: string | null;
  failed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BillingCommandListResponseDto {
  commands: BillingCommandDto[];
  next_cursor: string | null;
}

export interface BillingWebhookInboxEventDto {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  event_created_at: string;
  subscription_ref: string | null;
  checkout_session_ref: string | null;
  product_key: string;
  // RECEIVED | PROCESSING | PROCESSED | FAILED
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  outcome: string | null;
  detail: string | null;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface BillingWebhookInboxListResponseDto {
  events: BillingWebhookInboxEventDto[];
  next_cursor: string | null;
}
