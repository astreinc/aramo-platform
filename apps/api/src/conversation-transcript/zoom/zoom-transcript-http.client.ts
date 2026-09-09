// CI-B5Z — Zoom Phone recording-transcript HTTP client. There is NO reusable
// Zoom HTTP client in the repo (recon), so this is purpose-built and bounded:
//   * uses the FIXED official endpoint keyed by recordingId (not an arbitrary
//     event-supplied URL) — inherently SSRF-safe at the entry point;
//   * follows redirects MANUALLY, validating every hop against a Zoom host
//     allowlist, HTTPS-only, no private/internal hosts, bounded hop count;
//   * caps response size and applies connect/read timeouts;
//   * classifies failures into retryable vs terminal (safe codes; NO transcript
//     text or token in any error/log);
//   * on 401 refreshes the token ONCE via the injected token provider.
// Production Zoom is never called in B5Z — `fetchImpl` is injected and mocked.

import {
  ZOOM_API_BASE_URL,
  ZOOM_API_HOST,
  ZOOM_TRANSCRIPT_MAX_BYTES,
  ZOOM_TRANSCRIPT_MAX_REDIRECTS,
  ZOOM_TRANSCRIPT_READ_TIMEOUT_MS,
  zoomRecordingTranscriptPath,
} from './zoom-transcript.constants.js';

/** Safe error codes (never carry provider body / token). */
export const ZOOM_TRANSCRIPT_ERROR_CODES = {
  RETRYABLE_RATE_LIMITED: 'ZOOM_TRANSCRIPT_RATE_LIMITED',
  RETRYABLE_SERVER: 'ZOOM_TRANSCRIPT_SERVER_ERROR',
  RETRYABLE_TIMEOUT: 'ZOOM_TRANSCRIPT_TIMEOUT',
  RETRYABLE_NETWORK: 'ZOOM_TRANSCRIPT_NETWORK_ERROR',
  RETRYABLE_NOT_READY: 'ZOOM_TRANSCRIPT_NOT_READY',
  RETRYABLE_TOKEN: 'ZOOM_TRANSCRIPT_TOKEN_REFRESH_FAILED',
  TERMINAL_FORBIDDEN: 'ZOOM_TRANSCRIPT_FORBIDDEN',
  TERMINAL_NOT_FOUND: 'ZOOM_TRANSCRIPT_NOT_FOUND',
  TERMINAL_TOO_LARGE: 'ZOOM_TRANSCRIPT_TOO_LARGE',
  TERMINAL_UNSAFE_REDIRECT: 'ZOOM_TRANSCRIPT_UNSAFE_REDIRECT',
  TERMINAL_EMPTY: 'ZOOM_TRANSCRIPT_EMPTY',
} as const;

export class ZoomTranscriptFetchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  constructor(code: string, retryable: boolean, retryAfterSeconds?: number) {
    super(`zoom transcript fetch failed: ${code}`);
    this.name = 'ZoomTranscriptFetchError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Resolves a bearer token from a tenant-scoped IntegrationConnection secret_ref. */
export interface ZoomAccessTokenProvider {
  getAccessToken(secretRef: string): Promise<string>;
  /** Force a refresh (called once on 401). */
  refreshAccessToken(secretRef: string): Promise<string>;
}

/** Minimal Fetch subset (so global fetch works and tests inject a mock). */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface DownloadTranscriptInput {
  readonly tenantSecretRef: string;
  readonly recordingId: string;
}

export interface DownloadedTranscript {
  readonly bytes: Buffer;
  readonly contentType: string | undefined;
}

/** Host allowlist: the Zoom API host + its asset subdomains (signed redirects). */
function isAllowedZoomHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === ZOOM_API_HOST || h === 'zoom.us' || h.endsWith('.zoom.us');
}

function isPrivateOrUnsafeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // Literal private/loopback/link-local IPv4 + IPv6.
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^fe80:|^fc00:|^fd00:/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_UNSAFE_REDIRECT, false);
  }
  if (u.protocol !== 'https:' || isPrivateOrUnsafeHost(u.hostname) || !isAllowedZoomHost(u.hostname)) {
    throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_UNSAFE_REDIRECT, false);
  }
  return u;
}

export class ZoomTranscriptHttpClient {
  constructor(
    private readonly tokens: ZoomAccessTokenProvider,
    private readonly fetchImpl: FetchLike,
    private readonly readTimeoutMs: number = ZOOM_TRANSCRIPT_READ_TIMEOUT_MS,
    private readonly maxBytes: number = ZOOM_TRANSCRIPT_MAX_BYTES,
  ) {}

  /** Download the full recording transcript body via the fixed official endpoint. */
  async downloadRecordingTranscript(input: DownloadTranscriptInput): Promise<DownloadedTranscript> {
    const startUrl = assertSafeUrl(ZOOM_API_BASE_URL + zoomRecordingTranscriptPath(input.recordingId));
    let token = await this.tokens.getAccessToken(input.tenantSecretRef);
    let refreshed = false;
    let url = startUrl;

    for (let hop = 0; hop <= ZOOM_TRANSCRIPT_MAX_REDIRECTS; hop += 1) {
      const res = await this.fetchOnce(url, token);

      if (res.status === 401 && !refreshed) {
        // Single token refresh, then retry the SAME url.
        refreshed = true;
        try {
          token = await this.tokens.refreshAccessToken(input.tenantSecretRef);
        } catch {
          throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_TOKEN, true);
        }
        continue;
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null || hop === ZOOM_TRANSCRIPT_MAX_REDIRECTS) {
          throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_UNSAFE_REDIRECT, false);
        }
        url = assertSafeUrl(new URL(location, url).toString());
        continue;
      }

      return this.handleTerminalResponse(res);
    }
    throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_UNSAFE_REDIRECT, false);
  }

  private async fetchOnce(url: URL, token: string): Promise<FetchResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.readTimeoutMs);
    try {
      return await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'text/vtt, text/plain, */*' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_TIMEOUT, true);
      }
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_NETWORK, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleTerminalResponse(res: FetchResponseLike): Promise<DownloadedTranscript> {
    const { status } = res;
    if (status === 429) {
      const ra = res.headers.get('retry-after');
      const seconds = ra !== null && /^\d+$/.test(ra) ? Number(ra) : undefined;
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_RATE_LIMITED, true, seconds);
    }
    if (status >= 500) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_SERVER, true);
    }
    if (status === 404) {
      // Zoom returns 404/errorer while the transcript is still generating.
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.RETRYABLE_NOT_READY, true);
    }
    if (status === 403) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_FORBIDDEN, false);
    }
    if (status !== 200) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_NOT_FOUND, false);
    }
    // Size guard: reject an over-large declared length up-front.
    const declared = res.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > this.maxBytes) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_TOO_LARGE, false);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > this.maxBytes) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_TOO_LARGE, false);
    }
    if (buf.byteLength === 0) {
      throw new ZoomTranscriptFetchError(ZOOM_TRANSCRIPT_ERROR_CODES.TERMINAL_EMPTY, false);
    }
    return { bytes: buf, contentType: res.headers.get('content-type') ?? undefined };
  }
}
