import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { SignIntegrationRepository, SignWebhookRepository, type SignWebhookSubscriptionRow } from '@aramo/sign';
import { ESIGN_SCOPE } from '@aramo/identity';

import { SenderContextService } from '../sender/sender-context.service.js';

import { digest, newClientId, newClientSecret } from './credentials.js';
import { encryptWebhookSecret, newWebhookSecret, webhookSecretsAvailable } from './webhook-secrets.js';
import { checkTargetResolves } from './webhook-target.js';

// The lifecycle events Aramo Sign publishes (S-5 subscriptions filter on these;
// an empty list subscribes to all).
export const SIGN_WEBHOOK_EVENT_TYPES = ['sign.envelope.executed.v1'] as const;

// Sign Unified Product S-4 (directive §4.4.1) — installation administration in the
// Sign workspace (sign:integration:manage — Sign Admin / Owner). An installation
// needs explicit tenant authority and a bounded grant set:
//   - grants ⊆ what the application requested, and only esign:* permissions;
//   - modes ⊆ the application's modes; APPLICATION mode needs an integration
//     role (Sign Admin, Sender or Viewer — never Owner);
//   - role assertion only for roles the application declares assertable, and a
//     mapping can only narrow (the token endpoint intersects).
// A third-party client secret is shown ONCE at creation and stored as a digest.
// Revoking an installation revokes its credentials and every live token.

const ALLOWED_ROLES = new Set(['sign_admin', 'sign_sender', 'sign_viewer']);
const KNOWN_PERMISSIONS = new Set<string>(Object.values(ESIGN_SCOPE));

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}
function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'No such installation in this organization', 404, { requestId });
}
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export interface InstallBody {
  application_key?: unknown;
  granted_permissions?: unknown;
  modes?: unknown;
  integration_role?: unknown;
  role_assertion_enabled?: unknown;
}

@Injectable()
export class IntegrationAdminService {
  private readonly log = new Logger(IntegrationAdminService.name);

  constructor(
    private readonly repo: SignIntegrationRepository,
    private readonly ctx: SenderContextService,
    private readonly webhooks: SignWebhookRepository,
  ) {}

  private async business(auth: AuthContextType, requestId: string): Promise<void> {
    if ((await this.ctx.tenantKind(auth.tenant_id, requestId)) !== 'BUSINESS') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Integrations are available to organization accounts only', 403, { requestId, details: { reason: 'personal_account' } });
    }
  }

  async list(auth: AuthContextType, requestId: string) {
    await this.business(auth, requestId);
    const [apps, installs] = await Promise.all([this.repo.listActiveApplications(), this.repo.listInstallations(auth.tenant_id)]);
    return {
      applications: apps.map((a) => ({ key: a.key, name: a.name, kind: a.kind, requested_permissions: a.requested_permissions, modes: a.modes, assertable_roles: a.assertable_roles })),
      installations: installs.map((i) => ({
        id: i.id,
        application: { key: i.application.key, name: i.application.name, kind: i.application.kind },
        status: i.status,
        granted_permissions: i.granted_permissions,
        modes: i.modes,
        integration_role: i.integration_role,
        role_assertion_enabled: i.role_assertion_enabled,
        established: i.first_party_auto ? 'AUTOMATIC' : 'APPROVED',
        approved_at: i.approved_at.toISOString(),
        revoked_at: i.revoked_at?.toISOString() ?? null,
        role_mappings: i.role_mappings.map((m) => ({ external_role: m.external_role, sign_role: m.sign_role })),
        credentials: i.credentials.map((c) => ({ id: c.id, client_id: c.client_id, created_at: c.created_at.toISOString(), last_used_at: c.last_used_at?.toISOString() ?? null })),
      })),
    };
  }

  private async validateGrant(body: InstallBody, app: { requested_permissions: string[]; modes: string[]; assertable_roles: string[] }, requestId: string) {
    if (!stringArray(body.granted_permissions) || body.granted_permissions.length === 0) throw bad(requestId, 'granted_permissions must list at least one permission');
    const unknown = body.granted_permissions.filter((p) => !KNOWN_PERMISSIONS.has(p as never));
    if (unknown.length > 0) throw bad(requestId, 'unknown Sign permission', { unknown });
    const beyond = body.granted_permissions.filter((p) => !app.requested_permissions.includes(p));
    if (beyond.length > 0) throw bad(requestId, 'a grant cannot exceed what the application requested', { beyond });
    if (!stringArray(body.modes) || body.modes.length === 0 || body.modes.some((m) => !app.modes.includes(m))) {
      throw bad(requestId, 'modes must be a non-empty subset of the application’s modes', { allowed: app.modes });
    }
    const role = body.integration_role === undefined || body.integration_role === null ? null : body.integration_role;
    if (role !== null && (typeof role !== 'string' || !ALLOWED_ROLES.has(role))) throw bad(requestId, 'integration_role must be sign_admin, sign_sender or sign_viewer');
    if (body.modes.includes('APPLICATION') && role === null) throw bad(requestId, 'APPLICATION mode needs an integration_role');
    const assertion = body.role_assertion_enabled === true;
    if (assertion && app.assertable_roles.length === 0) throw bad(requestId, 'this application declares no assertable roles');
    return { granted_permissions: [...new Set(body.granted_permissions)], modes: [...new Set(body.modes)], integration_role: role as string | null, role_assertion_enabled: assertion };
  }

  async install(auth: AuthContextType, body: InstallBody, requestId: string) {
    await this.business(auth, requestId);
    if (typeof body?.application_key !== 'string') throw bad(requestId, 'application_key is required');
    const app = await this.repo.findApplicationByKey(body.application_key);
    if (app === null || app.status !== 'ACTIVE') throw new AramoError('NOT_FOUND', 'No such application', 404, { requestId });
    const grant = await this.validateGrant(body, app, requestId);
    const inst = await this.repo.upsertInstallation({ tenant_id: auth.tenant_id, application_id: app.id, approved_by: auth.sub, first_party_auto: false, ...grant });
    this.log.log(`installation approved tenant=${auth.tenant_id} app=${app.key} installation=${inst.id} by=${auth.sub} grants=${grant.granted_permissions.join(',')} modes=${grant.modes.join(',')} request=${requestId}`);
    return this.one(auth, inst.id, requestId);
  }

  async update(auth: AuthContextType, id: string, body: InstallBody, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    if (inst.status !== 'ACTIVE') throw new AramoError('ESIGN_INSTALLATION_REVOKED', 'A revoked installation must be installed again', 409, { requestId, details: { reason: 'installation_revoked' } });
    const grant = await this.validateGrant(body, inst.application, requestId);
    await this.repo.updateInstallationGrant(auth.tenant_id, id, grant);
    this.log.log(`installation updated tenant=${auth.tenant_id} installation=${id} by=${auth.sub} grants=${grant.granted_permissions.join(',')} request=${requestId}`);
    return this.one(auth, id, requestId);
  }

  async revoke(auth: AuthContextType, id: string, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    await this.repo.revokeInstallation(auth.tenant_id, id, auth.sub);
    this.log.log(`installation revoked tenant=${auth.tenant_id} installation=${id} by=${auth.sub} request=${requestId}`);
    return this.one(auth, id, requestId);
  }

  async createCredential(auth: AuthContextType, id: string, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    if (inst.status !== 'ACTIVE') throw new AramoError('ESIGN_INSTALLATION_REVOKED', 'The installation is revoked', 409, { requestId, details: { reason: 'installation_revoked' } });
    if (inst.application.kind !== 'THIRD_PARTY') throw bad(requestId, 'Aramo applications use operator-provisioned credentials', { reason: 'first_party_credentials' });
    const client_id = newClientId();
    const client_secret = newClientSecret();
    const cred = await this.repo.createCredential({ application_id: inst.application_id, installation_id: inst.id, client_id, secret_hash: digest(client_secret), created_by: auth.sub });
    this.log.log(`credential created tenant=${auth.tenant_id} installation=${id} credential=${cred.id} client_id=${client_id} by=${auth.sub} request=${requestId}`);
    // The secret is returned ONCE and never stored or shown again.
    return { id: cred.id, client_id, client_secret, created_at: cred.created_at.toISOString() };
  }

  async revokeCredential(auth: AuthContextType, id: string, credential_id: string, requestId: string) {
    await this.business(auth, requestId);
    const ok = await this.repo.revokeCredential(auth.tenant_id, id, credential_id);
    if (!ok) throw new AramoError('NOT_FOUND', 'No such active credential on this installation', 404, { requestId });
    this.log.log(`credential revoked tenant=${auth.tenant_id} installation=${id} credential=${credential_id} by=${auth.sub} request=${requestId}`);
    return { revoked: true };
  }

  async setRoleMappings(auth: AuthContextType, id: string, body: { mappings?: unknown }, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    if (!Array.isArray(body?.mappings) || body.mappings.length > 100) throw bad(requestId, 'mappings must be an array (at most 100)');
    const seen = new Set<string>();
    const mappings = body.mappings.map((raw: unknown, i: number) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const external_role = o['external_role'];
      const sign_role = o['sign_role'];
      if (typeof external_role !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(external_role)) throw bad(requestId, `mapping ${i + 1}: invalid external_role`);
      if (!inst.application.assertable_roles.includes(external_role)) throw bad(requestId, `mapping ${i + 1}: the application does not assert “${external_role}”`);
      if (typeof sign_role !== 'string' || !ALLOWED_ROLES.has(sign_role)) throw bad(requestId, `mapping ${i + 1}: sign_role must be sign_admin, sign_sender or sign_viewer`);
      if (seen.has(external_role)) throw bad(requestId, `mapping ${i + 1}: duplicate external_role`);
      seen.add(external_role);
      return { external_role, sign_role };
    });
    await this.repo.replaceRoleMappings(inst.id, mappings);
    this.log.log(`role mappings set tenant=${auth.tenant_id} installation=${id} count=${mappings.length} by=${auth.sub} request=${requestId}`);
    return this.one(auth, id, requestId);
  }

  // ── Sign Unified Product S-5 — webhook subscriptions of an installation ──────
  private webhookView(w: SignWebhookSubscriptionRow) {
    return {
      id: w.id,
      target_url: w.target_url,
      event_types: w.event_types,
      status: w.status,
      created_at: w.created_at.toISOString(),
      secret_rotated_at: w.secret_rotated_at?.toISOString() ?? null,
    };
  }

  private async activeInstallation(auth: AuthContextType, id: string, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    if (inst.status !== 'ACTIVE') throw new AramoError('ESIGN_INSTALLATION_REVOKED', 'The installation is revoked', 409, { requestId, details: { reason: 'installation_revoked' } });
    return inst;
  }

  private requireKey(requestId: string): void {
    if (!webhookSecretsAvailable()) {
      throw new AramoError('ESIGN_WEBHOOKS_UNAVAILABLE', 'Webhooks are not available right now', 503, { requestId, details: { reason: 'secret_key_unconfigured' } });
    }
  }

  async listWebhooks(auth: AuthContextType, id: string, requestId: string) {
    await this.business(auth, requestId);
    const inst = await this.repo.getInstallation(auth.tenant_id, id);
    if (inst === null) throw notFound(requestId);
    return { items: (await this.webhooks.listForInstallation(auth.tenant_id, id)).map((w) => this.webhookView(w)), event_types: [...SIGN_WEBHOOK_EVENT_TYPES] };
  }

  async createWebhook(auth: AuthContextType, id: string, body: { target_url?: unknown; event_types?: unknown }, requestId: string) {
    const inst = await this.activeInstallation(auth, id, requestId);
    this.requireKey(requestId);
    if (typeof body?.target_url !== 'string' || body.target_url.length > 2048) throw bad(requestId, 'target_url is required');
    const refusal = await checkTargetResolves(body.target_url);
    if (refusal !== null) throw bad(requestId, 'The webhook address must be a public HTTPS URL', { reason: refusal });
    const types = body.event_types === undefined ? [] : body.event_types;
    if (!stringArray(types) || types.some((t) => !(SIGN_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t))) {
      throw bad(requestId, 'unknown event type', { allowed: SIGN_WEBHOOK_EVENT_TYPES });
    }
    const secret = newWebhookSecret();
    const w = await this.webhooks.createSubscription({
      application_id: inst.application_id,
      installation_id: inst.id,
      tenant_id: auth.tenant_id,
      target_url: body.target_url,
      event_types: [...new Set(types)],
      secret_ciphertext: encryptWebhookSecret(secret),
      internal: false,
      created_by: auth.sub,
    });
    this.log.log(`webhook created tenant=${auth.tenant_id} installation=${id} webhook=${w.id} by=${auth.sub} request=${requestId}`);
    // The signing secret is returned ONCE.
    return { ...this.webhookView(w), signing_secret: secret };
  }

  async rotateWebhookSecret(auth: AuthContextType, id: string, webhook_id: string, requestId: string) {
    await this.activeInstallation(auth, id, requestId);
    this.requireKey(requestId);
    const w = await this.webhooks.getForInstallation(auth.tenant_id, id, webhook_id);
    if (w === null) throw new AramoError('NOT_FOUND', 'No such webhook on this installation', 404, { requestId });
    const secret = newWebhookSecret();
    await this.webhooks.rotateSecret(w.id, encryptWebhookSecret(secret));
    this.log.log(`webhook secret rotated tenant=${auth.tenant_id} webhook=${w.id} by=${auth.sub} request=${requestId}`);
    return { id: w.id, signing_secret: secret };
  }

  async setWebhookStatus(auth: AuthContextType, id: string, webhook_id: string, status: 'ACTIVE' | 'DISABLED', requestId: string) {
    await this.business(auth, requestId);
    const w = await this.webhooks.getForInstallation(auth.tenant_id, id, webhook_id);
    if (w === null) throw new AramoError('NOT_FOUND', 'No such webhook on this installation', 404, { requestId });
    await this.webhooks.setStatus(w.id, status);
    this.log.log(`webhook ${status === 'ACTIVE' ? 'enabled' : 'disabled'} tenant=${auth.tenant_id} webhook=${w.id} by=${auth.sub} request=${requestId}`);
    return this.webhookView({ ...w, status });
  }

  private async one(auth: AuthContextType, id: string, requestId: string) {
    const all = await this.list(auth, requestId);
    const found = all.installations.find((i) => i.id === id);
    if (found === undefined) throw notFound(requestId);
    return found;
  }
}
