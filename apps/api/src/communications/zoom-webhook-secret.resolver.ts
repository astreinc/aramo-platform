import { Inject, Injectable } from '@nestjs/common';
import { SECRETS_MANAGER_PORT, type SecretsManagerPort } from '@aramo/integration';

// COMM-B6 — resolve the app-level Zoom webhook signing secret at the composition
// root. The env carries only an opaque REFERENCE (ZOOM_WEBHOOK_SECRET_REF), NOT
// the raw secret; the actual secret is fetched through the Secrets Manager READ
// abstraction and kept memory-only. This is provider-app configuration (one
// signing secret per Zoom app), NOT a tenant's recruiter OAuth credential, so it
// does not live in any B3 ZoomCredentialBundle.
//
// Required characteristics (directive B6 secret ruling):
//   - the raw secret NEVER touches Postgres;
//   - it is NEVER returned by the API and NEVER logged;
//   - FAIL-CLOSED: an unset ref OR a resolution failure yields null, and the
//     webhook then refuses (503, dark-by-construction) — the signature can never
//     be checked against a fallback/blank secret.

export const ZOOM_WEBHOOK_SECRET_REF_ENV = 'ZOOM_WEBHOOK_SECRET_REF';

@Injectable()
export class ZoomWebhookSecretResolver {
  private cached: string | null = null;

  constructor(
    @Inject(SECRETS_MANAGER_PORT) private readonly secrets: SecretsManagerPort,
  ) {}

  /**
   * Resolve the signing secret, or null when unavailable (fail-closed). Caches
   * the resolved value in memory after the first success. Never logs the secret
   * or the resolution error detail.
   */
  async resolve(): Promise<string | null> {
    if (this.cached !== null) return this.cached;
    const ref = process.env[ZOOM_WEBHOOK_SECRET_REF_ENV];
    if (ref === undefined || ref.length === 0) return null;
    try {
      const secret = await this.secrets.getSecretValue(ref);
      if (secret.length === 0) return null;
      this.cached = secret;
      return secret;
    } catch {
      // Fail closed — do not leak the resolution error; the caller returns 503.
      return null;
    }
  }
}
