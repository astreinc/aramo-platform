// Auth-Decoupling PR-5a (ADR-0021 §2). Auth's OWN port over the portal-identity
// substrate. ONE port covering ALL current @aramo/portal-identity use in
// portal-login.service.ts (R-P5a-2): the 6 PortalIdentityRepository methods
// (mirrored EXACTLY) PLUS the 3 login-token helper functions (§7.2 — auth imports
// them today, so they must go behind the port to clear the §4.5 acceptance). The
// PortalIdentityRepositoryAdapter delegates to the real repository + helpers.
//
// Row types are re-declared here (mirroring PortalUserRow / PortalLoginTokenRow
// exactly) so the port is self-contained — no @aramo/portal-identity import — per
// the §4.5 sweep. NOT split (token-store relocation is a schema move, deferred —
// R-P5a-2). The adapter is a pass-through; a port suffices for extraction
// regardless of which schema the rows live in.

export interface PortalUser {
  id: string;
  email_normalized: string;
  cluster_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface PortalLoginToken {
  id: string;
  email_normalized: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export const PORTAL_IDENTITY_STORE = 'PORTAL_IDENTITY_STORE';

export interface PortalIdentityStore {
  // ── Repository methods (mirror PortalIdentityRepository exactly) ──────────────
  findPortalByEmail(emailNormalized: string): Promise<PortalUser | null>;
  findOrCreatePortalOnLogin(input: {
    email_normalized: string;
    cluster_id: string | null;
    now: Date;
  }): Promise<PortalUser>;
  createLoginToken(input: {
    email_normalized: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginToken>;
  findOpenLoginToken(emailNormalized: string, now: Date): Promise<PortalLoginToken | null>;
  rotateLoginToken(input: {
    id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginToken>;
  consumeLoginToken(tokenHash: string, now: Date): Promise<PortalLoginToken | null>;

  // ── Login-token helpers (mirror the @aramo/portal-identity functions) ─────────
  generatePortalLoginToken(): { raw: string; hash: string };
  hashPortalLoginToken(raw: string): string;
  portalLoginExpiresAt(now: Date): Date;
}
