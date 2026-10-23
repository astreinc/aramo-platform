import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// ATI-SEP-1 (ADR-0036 §3) — an in-process Talent Intelligence stub for the
// aramo-core provider verifier (verify-api.ts). The ATS reaches TI ONLY over HTTP
// through IntelligenceClient, so the verifier points INTELLIGENCE_SERVICE_URL at
// this server and each provider state programs the deterministic TI answers its
// interaction needs. The REAL TI service contract is verified separately by
// verify-ti.ts (intelligence-integration → talent-intelligence-service); this stub
// only has to answer the routes the ATS surfaces call, with the shapes of
// @aramo/intelligence-contracts.
//
// Defaults (after reset()): POST /v1/oauth/token answers a token; every other
// route answers 404 { error: { code: 'NOT_FOUND' } } — which the ATS read path
// treats as "enabled, nothing to show" and the action path as a uniform 404.

export interface TiStubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface TiStubResponse {
  status: number;
  body?: unknown;
}

export type TiStubHandler = (req: TiStubRequest) => TiStubResponse;

interface Route {
  method: string;
  pattern: RegExp;
  handler: TiStubHandler;
}

export const TI_STUB_CLIENT_ID = 'pact-ats-client';
export const TI_STUB_CLIENT_SECRET = 'pact-ats-client-secret-0123456789abcdef';
const TI_STUB_ACCESS_TOKEN = 'pact-ti-stub-access-token';

export class TiStub {
  private server: Server | null = null;
  private routes: Route[] = [];
  /** Every request the stub served since the last reset() (diagnostics). */
  readonly seen: TiStubRequest[] = [];

  async start(): Promise<string> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s === null) return;
    await new Promise<void>((resolveClose) => s.close(() => resolveClose()));
  }

  /** Forget every programmed route (each provider state starts from the defaults). */
  reset(): void {
    this.routes = [];
    this.seen.length = 0;
  }

  /** Program one route. `path` is an exact path or a RegExp over the path (no query). */
  on(method: string, path: string | RegExp, response: TiStubResponse | TiStubHandler): this {
    const pattern = typeof path === 'string' ? new RegExp(`^${escapeRegExp(path)}$`) : path;
    const handler: TiStubHandler = typeof response === 'function' ? response : () => response;
    // Later registrations win (a state can override an earlier default).
    this.routes.unshift({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ti-stub');
    const raw = await readBody(req);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request: TiStubRequest = { method: (req.method ?? 'GET').toUpperCase(), path: url.pathname, query: url.searchParams, body };
    this.seen.push(request);
    const out = this.answer(request, req.headers['authorization']);
    res.statusCode = out.status;
    res.setHeader('content-type', 'application/json');
    res.end(out.body === undefined ? '' : JSON.stringify(out.body));
  }

  private answer(req: TiStubRequest, authorization: string | undefined): TiStubResponse {
    if (req.method === 'POST' && req.path === '/v1/oauth/token') {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b['grant_type'] !== 'client_credentials' || b['client_id'] !== TI_STUB_CLIENT_ID || b['client_secret'] !== TI_STUB_CLIENT_SECRET) {
        return { status: 401, body: { error: 'invalid_client', error_description: 'unknown client' } };
      }
      return { status: 200, body: { access_token: TI_STUB_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'intelligence:read' } };
    }
    if (authorization !== `Bearer ${TI_STUB_ACCESS_TOKEN}`) {
      return { status: 401, body: { error: { code: 'INVALID_TOKEN', message: 'invalid service token' } } };
    }
    for (const r of this.routes) {
      if (r.method === req.method && r.pattern.test(req.path)) return r.handler(req);
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/** The TI reference path of an ATS talent record: /v1/references/ARAMO_ATS/:tenant/:record. */
export function tiReferencePath(tenantId: string, recordId: string): string {
  return `/v1/references/ARAMO_ATS/${tenantId}/${recordId}`;
}

/** A TI refusal body ({ error: { code, message, ...details } }). */
export function tiRefusal(status: number, code: string, details: Record<string, unknown> = {}): TiStubResponse {
  return { status, body: { error: { code, message: code.toLowerCase().replace(/_/g, ' '), ...details } } };
}
