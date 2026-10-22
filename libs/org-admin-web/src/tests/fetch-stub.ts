import { vi } from 'vitest';

// ORG-UX-1 page specs — a minimal fetch router over the real API clients.
export interface StubCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export type StubHandler = (call: StubCall) => { status?: number; body?: unknown } | undefined;

export function stubFetch(handler: StubHandler): StubCall[] {
  const calls: StubCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = init?.body;
    const body = typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const res = handler(call) ?? (url.startsWith('/v1/me') ? { body: { user: { display_name: 'Olive', email: 'o@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } } } : { body: {} });
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(res.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
