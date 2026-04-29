import { describe, expect, it, vi } from 'vitest';

import { RequestIdMiddleware } from '../lib/middleware/request-id.middleware.js';

interface MockRequest {
  header: (name: string) => string | undefined;
  requestId?: string;
}
interface MockResponse {
  setHeader: (name: string, value: string) => void;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeRequest(headerValue?: string): MockRequest {
  return {
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'x-request-id' ? headerValue : undefined,
  };
}

function makeResponse(): { res: MockResponse; setHeader: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  return { res: { setHeader }, setHeader };
}

describe('RequestIdMiddleware', () => {
  it('generates a UUID v7 when X-Request-ID is absent', () => {
    const mw = new RequestIdMiddleware();
    const request = makeRequest();
    const { res, setHeader } = makeResponse();
    const next = vi.fn();
    mw.use(request as never, res as never, next);
    expect(request.requestId).toBeDefined();
    expect(UUID_REGEX.test(request.requestId ?? '')).toBe(true);
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', request.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through a valid client-supplied X-Request-ID', () => {
    const mw = new RequestIdMiddleware();
    const supplied = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';
    const request = makeRequest(supplied);
    const { res, setHeader } = makeResponse();
    const next = vi.fn();
    mw.use(request as never, res as never, next);
    expect(request.requestId).toBe(supplied);
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', supplied);
  });

  it('replaces an invalid X-Request-ID with a generated UUID v7', () => {
    const mw = new RequestIdMiddleware();
    const request = makeRequest('not-a-uuid');
    const { res } = makeResponse();
    const next = vi.fn();
    mw.use(request as never, res as never, next);
    expect(request.requestId).not.toBe('not-a-uuid');
    expect(UUID_REGEX.test(request.requestId ?? '')).toBe(true);
  });
});
