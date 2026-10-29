import type {
  SignEraseResult,
  SignErasureCounts,
  SignErasureHolder,
  SignErasurePort,
  SignErasureScope,
} from '../talent-identity/sign-erasure.port.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-3, §4 D-1 — the
// HTTP client of the Sign-owned talent-erasure contract (sign-service
// /v1/sign/s2s/talent-erasure/*, compose-internal only). The ATS authenticates as its
// first-party Sign API client (SIGN_ATS_CLIENT_ID / SIGN_ATS_CLIENT_SECRET, HTTP Basic).
// Fail closed: without the credential no request is sent and the call throws, which the
// engine reports as a blocker (preflight) or a pending run (erase). The secret and the
// record ids are never logged.

export class SignTalentErasureClient implements SignErasurePort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private baseUrl(): string {
    return (this.env['SIGN_SERVICE_URL'] ?? 'http://localhost:3003').replace(/\/+$/, '');
  }

  private authorization(): string {
    const id = this.env['SIGN_ATS_CLIENT_ID'];
    const secret = this.env['SIGN_ATS_CLIENT_SECRET'];
    if (id === undefined || id === '' || secret === undefined || secret === '') {
      throw new Error('Aramo Sign talent erasure not attempted: SIGN_ATS_CLIENT_ID / SIGN_ATS_CLIENT_SECRET are not configured');
    }
    return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`, 'utf8').toString('base64')}`;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}/v1/sign/s2s/talent-erasure/${path}`, {
      method: 'POST',
      headers: { authorization: this.authorization(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Aramo Sign talent erasure ${path} refused: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  preflight(scope: SignErasureScope): Promise<{ holders: SignErasureHolder[]; erasable: SignErasureCounts }> {
    return this.post('preflight', scope);
  }

  erase(scope: SignErasureScope & { run_id: string }): Promise<SignEraseResult> {
    return this.post('erase', scope);
  }
}
