import { Injectable } from '@nestjs/common';
import {
  PortalIdentityRepository,
  generatePortalLoginToken,
  hashPortalLoginToken,
  portalLoginExpiresAt,
} from '@aramo/portal-identity';

import type {
  PortalIdentityStore,
  PortalLoginToken,
  PortalUser,
} from './portal-identity-store.port.js';

// Auth-Decoupling PR-5a (ADR-0021 §2) — the Aramo-side adapter implementing auth's
// PortalIdentityStore. Pure pass-through: the 6 repository methods delegate to
// PortalIdentityRepository; the 3 login-token helpers delegate to the
// @aramo/portal-identity module functions. This is the ONLY code importing
// @aramo/portal-identity; portal-login.service.ts no longer does (the §4.5 proof).
// Row types mirror the repository rows exactly, so the delegations are structural
// (no mapping). Token-store relocation is deferred (R-P5a-2) — the port is
// schema-agnostic.
@Injectable()
export class PortalIdentityRepositoryAdapter implements PortalIdentityStore {
  constructor(private readonly repo: PortalIdentityRepository) {}

  findPortalByEmail(emailNormalized: string): Promise<PortalUser | null> {
    return this.repo.findPortalByEmail(emailNormalized);
  }

  findOrCreatePortalOnLogin(input: {
    email_normalized: string;
    cluster_id: string | null;
    now: Date;
  }): Promise<PortalUser> {
    return this.repo.findOrCreatePortalOnLogin(input);
  }

  createLoginToken(input: {
    email_normalized: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginToken> {
    return this.repo.createLoginToken(input);
  }

  findOpenLoginToken(emailNormalized: string, now: Date): Promise<PortalLoginToken | null> {
    return this.repo.findOpenLoginToken(emailNormalized, now);
  }

  rotateLoginToken(input: {
    id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginToken> {
    return this.repo.rotateLoginToken(input);
  }

  consumeLoginToken(tokenHash: string, now: Date): Promise<PortalLoginToken | null> {
    return this.repo.consumeLoginToken(tokenHash, now);
  }

  generatePortalLoginToken(): { raw: string; hash: string } {
    return generatePortalLoginToken();
  }

  hashPortalLoginToken(raw: string): string {
    return hashPortalLoginToken(raw);
  }

  portalLoginExpiresAt(now: Date): Date {
    return portalLoginExpiresAt(now);
  }
}
