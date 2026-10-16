// TIP-E2E INC-3 A1-6 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §9, C-2/C-3, R-C) — the
// provider-NEUTRAL external meeting-capture intake boundary. One contract for
// any future capture vendor; it extends the existing B3
// ConversationTranscriptProvider port with a live-segment surface.
//
// NO VENDOR IS APPROVED (§9 vendor gate): nothing here is wired to a real
// provider, a route, a queue or a module. Only the fake adapter
// (fake-external-capture.provider.ts) implements it, for verification tests.
//
// Rules carried by this file:
//   - every event is SIGNED (HMAC-SHA256 over "<timestamp>.<raw body>", bounded
//     clock skew, constant-time compare) and IDEMPOTENT (event_id dedupe);
//   - the event's aramo_tenant_id must match the session it is applied to;
//   - final segments supersede partials; an older revision never overwrites;
//   - live segments are held only for the suggestion window and are NEVER
//     persisted here (post-meeting artifacts enter B3/B4 normally, C-3);
//   - live assistance fails closed unless the provider reported
//     session_started{admitted:true} AND transcription + ai_processing (and
//     recording, when the provider records) were confirmed BEFORE the join.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ConversationTranscriptProvider } from '../provider/conversation-transcript-provider.port.js';

export const EXTERNAL_CAPTURE_EVENT_TYPES = [
  'session_started',
  'transcript_segment',
  'session_ended',
  'artifact_ready',
  'artifact_deleted',
] as const;
export type ExternalCaptureEventType = (typeof EXTERNAL_CAPTURE_EVENT_TYPES)[number];

export type SpeakerAttribution = 'separate_stream' | 'speaker_event' | 'unknown';

export interface SessionStartedPayload {
  readonly joined_at: string;
  readonly capture_mode: string;
  readonly bot_display_name: string;
  readonly admitted: boolean;
}

export interface TranscriptSegmentPayload {
  readonly segment_id: string;
  readonly revision: number;
  readonly kind: 'partial' | 'final';
  readonly speaker: {
    readonly provider_participant_id: string;
    readonly display_name: string | null;
    readonly attribution: SpeakerAttribution;
  };
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
}

export interface SessionEndedPayload {
  readonly ended_at: string;
  readonly reason: string;
}

export interface ArtifactReadyPayload {
  readonly type: string;
  readonly format: string;
  readonly url: string;
  readonly url_expires_at: string;
  readonly retention_expires_at: string | null;
}

export interface ArtifactDeletedPayload {
  readonly artifact_type: string;
  readonly deleted_at: string;
}

interface Envelope<T extends ExternalCaptureEventType, P> {
  readonly event_id: string;
  readonly type: T;
  readonly provider: string;
  readonly provider_session_id: string;
  readonly aramo_tenant_id: string;
  readonly meeting_ref: string;
  readonly occurred_at: string;
  readonly payload: P;
}

export type ExternalCaptureEvent =
  | Envelope<'session_started', SessionStartedPayload>
  | Envelope<'transcript_segment', TranscriptSegmentPayload>
  | Envelope<'session_ended', SessionEndedPayload>
  | Envelope<'artifact_ready', ArtifactReadyPayload>
  | Envelope<'artifact_deleted', ArtifactDeletedPayload>;

/** Commands Aramo issues to a capture provider (§9). delete_artifacts confirms synchronously. */
export interface ExternalCaptureCommandPort {
  start(input: { tenant_id: string; meeting_ref: string; join_url: string; bot_display_name: string }): Promise<{
    provider_session_id: string;
  }>;
  stop(input: { tenant_id: string; provider_session_id: string; reason: string }): Promise<void>;
  deleteArtifacts(input: { tenant_id: string; provider_session_id: string }): Promise<{ confirmed: boolean }>;
}

/** A capture provider: the B3 post-meeting port plus the live command surface. */
export interface ExternalCaptureProvider extends ConversationTranscriptProvider, ExternalCaptureCommandPort {}

export class ExternalCaptureEventError extends Error {
  constructor(readonly reason: 'signature_invalid' | 'stale' | 'malformed' | 'tenant_mismatch') {
    super(`external capture event rejected: ${reason}`);
    this.name = 'ExternalCaptureEventError';
  }
}

export const EXTERNAL_CAPTURE_MAX_SKEW_MS = 5 * 60 * 1000;

export function signExternalCaptureEvent(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Verify signature + freshness BEFORE parsing. Throws ExternalCaptureEventError. */
export function verifyExternalCaptureSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  nowMs: number;
}): void {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs(input.nowMs - ts) > EXTERNAL_CAPTURE_MAX_SKEW_MS) {
    throw new ExternalCaptureEventError('stale');
  }
  const expected = Buffer.from(signExternalCaptureEvent(input.secret, input.timestamp, input.rawBody), 'hex');
  const given = /^[0-9a-f]{64}$/i.test(input.signature) ? Buffer.from(input.signature, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ExternalCaptureEventError('signature_invalid');
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Strict structural parse of a VERIFIED raw body. Throws ExternalCaptureEventError('malformed'). */
export function parseExternalCaptureEvent(rawBody: string): ExternalCaptureEvent {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ExternalCaptureEventError('malformed');
  }
  const bad = (): never => {
    throw new ExternalCaptureEventError('malformed');
  };
  if (o === null || typeof o !== 'object') bad();
  for (const k of ['event_id', 'provider', 'provider_session_id', 'aramo_tenant_id', 'meeting_ref', 'occurred_at']) {
    if (!isStr(o[k])) bad();
  }
  const type = o['type'];
  if (!EXTERNAL_CAPTURE_EVENT_TYPES.includes(type as ExternalCaptureEventType)) bad();
  const p = o['payload'] as Record<string, unknown> | null;
  if (p === null || typeof p !== 'object') bad();
  const payload = p as Record<string, unknown>;
  switch (type) {
    case 'session_started':
      if (!isStr(payload['joined_at']) || !isStr(payload['capture_mode']) || !isStr(payload['bot_display_name']) || typeof payload['admitted'] !== 'boolean') bad();
      break;
    case 'transcript_segment': {
      const sp = payload['speaker'] as Record<string, unknown> | null;
      if (
        !isStr(payload['segment_id']) ||
        !Number.isInteger(payload['revision']) ||
        (payload['kind'] !== 'partial' && payload['kind'] !== 'final') ||
        sp === null ||
        typeof sp !== 'object' ||
        !isStr(sp['provider_participant_id']) ||
        !(sp['display_name'] === null || typeof sp['display_name'] === 'string') ||
        !['separate_stream', 'speaker_event', 'unknown'].includes(sp['attribution'] as string) ||
        !isNum(payload['start_ms']) ||
        !isNum(payload['end_ms']) ||
        (payload['end_ms'] as number) < (payload['start_ms'] as number) ||
        typeof payload['text'] !== 'string'
      ) {
        bad();
      }
      break;
    }
    case 'session_ended':
      if (!isStr(payload['ended_at']) || !isStr(payload['reason'])) bad();
      break;
    case 'artifact_ready':
      if (!isStr(payload['type']) || !isStr(payload['format']) || !isStr(payload['url']) || !isStr(payload['url_expires_at'])) bad();
      break;
    case 'artifact_deleted':
      if (!isStr(payload['artifact_type']) || !isStr(payload['deleted_at'])) bad();
      break;
  }
  return o as unknown as ExternalCaptureEvent;
}

export interface LiveSegment {
  readonly segment_id: string;
  readonly revision: number;
  readonly kind: 'partial' | 'final';
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly attribution: SpeakerAttribution;
}

export type LiveApplyResult =
  | { readonly applied: false; readonly reason: 'duplicate' | 'superseded' | 'ended' }
  | { readonly applied: true; readonly event: ExternalCaptureEvent };

/**
 * In-memory, per-session live state. Never persisted. Idempotent by event_id;
 * final supersedes partial; a lower or equal revision never overwrites; a
 * tenant mismatch is refused; after session_ended or purge() it holds nothing.
 */
export class LiveCaptureSessionBuffer {
  private readonly seen = new Set<string>();
  private readonly segments = new Map<string, LiveSegment>();
  private admittedFlag = false;
  private ended = false;

  constructor(
    readonly tenant_id: string,
    readonly provider_session_id: string,
    private readonly windowMs = 120_000,
  ) {}

  get admitted(): boolean {
    return this.admittedFlag && !this.ended;
  }

  apply(event: ExternalCaptureEvent): LiveApplyResult {
    if (event.aramo_tenant_id !== this.tenant_id || event.provider_session_id !== this.provider_session_id) {
      throw new ExternalCaptureEventError('tenant_mismatch');
    }
    if (this.seen.has(event.event_id)) return { applied: false, reason: 'duplicate' };
    this.seen.add(event.event_id);
    if (this.ended && event.type !== 'artifact_ready' && event.type !== 'artifact_deleted') {
      return { applied: false, reason: 'ended' };
    }
    switch (event.type) {
      case 'session_started':
        this.admittedFlag = event.payload.admitted;
        break;
      case 'transcript_segment': {
        const s = event.payload;
        const prior = this.segments.get(s.segment_id);
        if (prior !== undefined && ((prior.kind === 'final' && s.kind === 'partial') || s.revision <= prior.revision)) {
          return { applied: false, reason: 'superseded' };
        }
        this.segments.set(s.segment_id, {
          segment_id: s.segment_id,
          revision: s.revision,
          kind: s.kind,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text: s.text,
          attribution: s.speaker.attribution,
        });
        this.evict();
        break;
      }
      case 'session_ended':
        this.ended = true;
        this.purge();
        break;
      default:
        break;
    }
    return { applied: true, event };
  }

  /** Final segments inside the suggestion window, oldest first. */
  finalWindow(): LiveSegment[] {
    return [...this.segments.values()].filter((s) => s.kind === 'final').sort((a, b) => a.start_ms - b.start_ms);
  }

  /** Drop every held segment (objection, end, or capture stop). */
  purge(): void {
    this.segments.clear();
  }

  get size(): number {
    return this.segments.size;
  }

  private evict(): void {
    let latest = 0;
    for (const s of this.segments.values()) latest = Math.max(latest, s.end_ms);
    for (const [id, s] of this.segments) if (s.end_ms < latest - this.windowMs) this.segments.delete(id);
  }
}

export interface LiveAssistConsent {
  readonly transcription: boolean;
  readonly ai_processing: boolean;
  readonly recording: boolean;
  /** Whether this provider records media (then `recording` is also required). */
  readonly provider_records: boolean;
  /** Consent was confirmed BEFORE the provider joined. */
  readonly confirmed_before_join: boolean;
}

export type LiveAssistDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'not_admitted' | 'consent_missing' | 'consent_after_join' };

/** §5 / §9 — live suggestions fail closed without an admitted, consented feed. */
export function evaluateLiveAssist(input: { admitted: boolean; consent: LiveAssistConsent }): LiveAssistDecision {
  if (!input.admitted) return { allowed: false, reason: 'not_admitted' };
  const c = input.consent;
  if (!c.transcription || !c.ai_processing || (c.provider_records && !c.recording)) {
    return { allowed: false, reason: 'consent_missing' };
  }
  if (!c.confirmed_before_join) return { allowed: false, reason: 'consent_after_join' };
  return { allowed: true };
}
