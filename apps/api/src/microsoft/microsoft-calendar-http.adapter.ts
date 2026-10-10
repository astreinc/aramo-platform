import { Injectable } from '@nestjs/common';
import {
  GraphCalendarError,
  type GraphCancelEventArgs,
  type GraphCreateEventArgs,
  type GraphEventResult,
  type GraphGetEventArgs,
  type GraphUpdateEventArgs,
  type MicrosoftCalendarPort,
} from '@aramo/microsoft-graph';

// COMM-C2B Amendment A1 — Microsoft Graph CALENDAR adapter (R3/R4/R6). Delegated
// calls against the signed-in recruiter's OWN calendar with Calendars.ReadWrite:
//   POST   /me/events                 — create event (attendees + Teams meeting)
//   PATCH  /me/events/{id}            — reschedule the SAME event
//   POST   /me/events/{id}/cancel     — cancel the SAME event (provider notifies)
//   GET    /me/events/{id}            — read for ambiguous-outcome reconciliation
// Provider errors are CLASSIFIED (429/Retry-After, 401 reauth, 5xx transient) and
// transient/network failures on a mutating call are marked AMBIGUOUS (R3): the
// caller must reconcile rather than blindly retry.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphRetryPolicy {
  /** Total attempts including the first. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  sleep(ms: number): Promise<void>;
}

export const DEFAULT_GRAPH_RETRY_POLICY: GraphRetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
}

function classify(status: number, retryAfterSeconds?: number): GraphCalendarError {
  if (status === 401) {
    return new GraphCalendarError(
      'reauth_required',
      401,
      'graph calendar: delegated authorization invalid or expired',
    );
  }
  if (status === 403) {
    return new GraphCalendarError('forbidden', 403, 'graph calendar: forbidden');
  }
  if (status === 404) {
    return new GraphCalendarError('not_found', 404, 'graph calendar: event not found');
  }
  if (status === 429) {
    return new GraphCalendarError(
      'throttled',
      429,
      'graph calendar: throttled',
      retryAfterSeconds,
    );
  }
  if (status >= 500) {
    // Outcome of a mutating 5xx is UNKNOWN — ambiguous (R3).
    return new GraphCalendarError('transient', status, `graph calendar: transient ${String(status)}`, retryAfterSeconds, true);
  }
  return new GraphCalendarError('permanent', status, `graph calendar: request failed ${String(status)}`);
}

interface GraphEventPayload {
  id?: string;
  webLink?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  isCancelled?: boolean;
  [k: string]: unknown;
}

function toResult(json: GraphEventPayload, fallback: { start: string; end: string }): GraphEventResult {
  return {
    provider_event_id: json.id ?? '',
    join_url: json.onlineMeeting?.joinUrl,
    web_link: json.webLink,
    start_date_time: json.start?.dateTime ?? fallback.start,
    end_date_time: json.end?.dateTime ?? fallback.end,
    status: json.isCancelled === true ? 'cancelled' : undefined,
  };
}

@Injectable()
export class MicrosoftCalendarHttpAdapter implements MicrosoftCalendarPort {
  constructor(private readonly retry: GraphRetryPolicy = DEFAULT_GRAPH_RETRY_POLICY) {}

  /**
   * Fetch with classified errors + bounded retry on throttling/transient failures.
   * `mutating` marks a write whose transient/network failure leaves provider state
   * UNKNOWN, so the exhausted error is thrown ambiguous (R3).
   */
  private async graphFetch(url: string, init: RequestInit, mutating: boolean): Promise<Response> {
    let lastErr: GraphCalendarError | undefined;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, init);
      } catch {
        // Network-level failure: unknown outcome for a mutating call (R3).
        lastErr = new GraphCalendarError('transient', 0, 'graph calendar: network failure', undefined, mutating);
        if (attempt < this.retry.attempts) {
          await this.retry.sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw lastErr;
      }
      if (res.ok) {
        return res;
      }
      const err = classify(res.status, parseRetryAfterSeconds(res.headers.get('retry-after')));
      // Only throttling and transient server errors are retryable.
      if ((err.kind === 'throttled' || err.kind === 'transient') && attempt < this.retry.attempts) {
        lastErr = err;
        const backoff = err.retryAfterSeconds !== undefined
          ? err.retryAfterSeconds * 1000
          : this.retry.baseDelayMs * 2 ** (attempt - 1);
        await this.retry.sleep(backoff);
        continue;
      }
      throw err;
    }
    // Loop only exits via return/throw; this satisfies the type checker.
    throw lastErr ?? new GraphCalendarError('permanent', 0, 'graph calendar: unreachable');
  }

  async createCalendarEvent(args: GraphCreateEventArgs): Promise<GraphEventResult> {
    const res = await this.graphFetch(
      `${GRAPH_BASE}/me/events`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${args.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          subject: args.subject,
          body: { contentType: 'Text', content: args.body ?? '' },
          start: { dateTime: args.startDateTime, timeZone: args.timeZone },
          end: { dateTime: args.endDateTime, timeZone: args.timeZone },
          attendees: args.attendees.map((a) => ({
            emailAddress: { address: a.email, name: a.name },
            type: a.type ?? 'required',
          })),
          isOnlineMeeting: args.isOnlineMeeting,
          onlineMeetingProvider: args.isOnlineMeeting ? 'teamsForBusiness' : undefined,
          // Provider-side duplicate-create guard (R3). NOT relied on as a lookup key.
          transactionId: args.transactionId,
        }),
      },
      true,
    );
    const json = (await res.json()) as GraphEventPayload;
    return toResult(json, { start: args.startDateTime, end: args.endDateTime });
  }

  async updateCalendarEvent(args: GraphUpdateEventArgs): Promise<GraphEventResult> {
    const patch: Record<string, unknown> = {};
    if (args.subject !== undefined) patch['subject'] = args.subject;
    if (args.body !== undefined) patch['body'] = { contentType: 'Text', content: args.body };
    if (args.startDateTime !== undefined) {
      patch['start'] = { dateTime: args.startDateTime, timeZone: args.timeZone };
    }
    if (args.endDateTime !== undefined) {
      patch['end'] = { dateTime: args.endDateTime, timeZone: args.timeZone };
    }
    if (args.attendees !== undefined) {
      patch['attendees'] = args.attendees.map((a) => ({
        emailAddress: { address: a.email, name: a.name },
        type: a.type ?? 'required',
      }));
    }
    const res = await this.graphFetch(
      `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${args.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(patch),
      },
      true,
    );
    const json = (await res.json()) as GraphEventPayload;
    return toResult(json, {
      start: args.startDateTime ?? '',
      end: args.endDateTime ?? '',
    });
  }

  async cancelCalendarEvent(args: GraphCancelEventArgs): Promise<void> {
    try {
      await this.graphFetch(
        `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}/cancel`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${args.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ comment: args.comment ?? '' }),
        },
        true,
      );
    } catch (err) {
      // Idempotent cancel: an already-absent event is a successful end state (R3).
      if (err instanceof GraphCalendarError && err.kind === 'not_found') {
        return;
      }
      throw err;
    }
  }

  async getCalendarEvent(args: GraphGetEventArgs): Promise<GraphEventResult | null> {
    try {
      const res = await this.graphFetch(
        `${GRAPH_BASE}/me/events/${encodeURIComponent(args.providerEventId)}`,
        { method: 'GET', headers: { authorization: `Bearer ${args.accessToken}` } },
        false,
      );
      const json = (await res.json()) as GraphEventPayload;
      return toResult(json, { start: '', end: '' });
    } catch (err) {
      if (err instanceof GraphCalendarError && err.kind === 'not_found') {
        return null;
      }
      throw err;
    }
  }
}
