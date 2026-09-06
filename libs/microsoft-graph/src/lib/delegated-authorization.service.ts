import {
  redactTokenBundle,
  tokenNeedsRefresh,
  type DelegatedTokenBundle,
  type RedactedTokenMetadata,
} from './domain/delegated-token.js';
import {
  buildMicrosoftAuthorizeUrl,
  decryptMicrosoftOAuthState,
  encryptMicrosoftOAuthState,
  generateMicrosoftPkce,
  isMicrosoftOAuthStateExpired,
  MicrosoftOAuthStateError,
} from './domain/oauth-state.js';
import {
  MicrosoftConsentRevokedError,
  type MicrosoftOAuthPort,
} from './ports/microsoft-oauth.port.js';
import {
  type DelegatedTokenStorePort,
} from './ports/delegated-token-store.port.js';
import {
  type ProviderIdentityBinding,
  type ProviderIdentityStorePort,
} from './ports/provider-identity-store.port.js';

// COMM-C2B — delegated authorization orchestration (directive R2/R4/R6/R7).
//
// Port-driven and I/O-free: the OAuth exchange, secret custody, and identity
// binding are all ports so this logic is unit-testable and the network/secret
// specifics live in apps/api adapters. Token material flows exchange → custody
// store only; the returned views carry NO tokens (R3).

/** The recruiter/provider identity must be (re)authorized before Graph actions. */
export class MicrosoftReauthRequiredError extends Error {
  constructor(message = 'microsoft identity requires reauthorization') {
    super(message);
    this.name = 'MicrosoftReauthRequiredError';
  }
}

/** No Microsoft identity is bound for this recruiter/connection. */
export class MicrosoftIdentityNotBoundError extends Error {
  constructor(message = 'no microsoft identity bound for recruiter') {
    super(message);
    this.name = 'MicrosoftIdentityNotBoundError';
  }
}

export interface StartAuthorizationArgs {
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly connection_id: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authorityTenant?: string;
  readonly nowEpochSeconds: number;
}

export interface StartAuthorizationResult {
  readonly authorizeUrl: string;
  readonly encryptedState: string;
}

export interface CompleteAuthorizationArgs {
  readonly code: string;
  readonly encryptedState: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly authorityTenant?: string;
  readonly nowEpochSeconds: number;
}

/** Token-free view of a completed authorization (R3). */
export interface AuthorizationResultView {
  readonly provider_identity_id: string;
  readonly tenant_id: string;
  readonly recruiter_id: string;
  readonly ms_tenant_id: string;
  readonly ms_object_id: string;
  readonly status: ProviderIdentityBinding['status'];
  readonly token: RedactedTokenMetadata;
}

export interface UsableTokenArgs {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly recruiter_id: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorityTenant?: string;
  readonly nowEpochSeconds: number;
}

export interface UsableToken {
  readonly access_token: string;
  readonly provider_identity_id: string;
  readonly ms_object_id: string;
}

export class DelegatedAuthorizationService {
  constructor(
    private readonly oauth: MicrosoftOAuthPort,
    private readonly tokenStore: DelegatedTokenStorePort,
    private readonly identities: ProviderIdentityStorePort,
  ) {}

  /** C2B-3 authorize/start — build the state + Microsoft authorize URL (R2). */
  startAuthorization(args: StartAuthorizationArgs): StartAuthorizationResult {
    const pkce = generateMicrosoftPkce();
    const encryptedState = encryptMicrosoftOAuthState({
      tenant_id: args.tenant_id,
      recruiter_id: args.recruiter_id,
      connection_id: args.connection_id,
      verifier: pkce.verifier,
      nonce: pkce.nonce,
      issued_at: args.nowEpochSeconds,
    });
    const authorizeUrl = buildMicrosoftAuthorizeUrl({
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      encryptedState,
      codeChallenge: pkce.challenge,
      authorityTenant: args.authorityTenant,
    });
    return { authorizeUrl, encryptedState };
  }

  /**
   * C2B-3 callback — validate state, exchange the code server-side, bind the
   * recruiter↔Microsoft identity, and write the token bundle to custody. Returns
   * a token-free view (R3). Throws MicrosoftOAuthStateError on a bad/expired
   * state (CSRF/replay guard).
   */
  async completeAuthorization(args: CompleteAuthorizationArgs): Promise<AuthorizationResultView> {
    const state = decryptMicrosoftOAuthState(args.encryptedState);
    if (isMicrosoftOAuthStateExpired(state, args.nowEpochSeconds)) {
      throw new MicrosoftOAuthStateError('state_expired');
    }
    const exchanged = await this.oauth.exchangeAuthorizationCode({
      code: args.code,
      codeVerifier: state.verifier,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      redirectUri: args.redirectUri,
      authorityTenant: args.authorityTenant,
    });

    const binding = await this.identities.upsert({
      tenant_id: state.tenant_id,
      integration_connection_id: state.connection_id,
      recruiter_id: state.recruiter_id,
      provider_user_id: exchanged.ms_object_id,
      ms_tenant_id: exchanged.ms_tenant_id,
      email_enabled: true,
    });

    const bundle = this.toBundle(exchanged, args.nowEpochSeconds);
    await this.tokenStore.write(
      { tenant_id: state.tenant_id, provider_identity_id: binding.id },
      bundle,
    );
    // Ensure a re-authorization flips a previously reauth_required/disabled row
    // back to active (R4/R7).
    const active =
      binding.status === 'active'
        ? binding
        : await this.identities.setStatus(state.tenant_id, binding.id, 'active');

    return {
      provider_identity_id: active.id,
      tenant_id: active.tenant_id,
      recruiter_id: active.recruiter_id,
      ms_tenant_id: active.ms_tenant_id,
      ms_object_id: active.provider_user_id,
      status: active.status,
      token: redactTokenBundle(bundle),
    };
  }

  /**
   * Resolve a usable access token for the bound recruiter, refreshing + rotating
   * custody when near expiry (R4). Binding-scoped: a recruiter can only reach
   * their OWN bundle (R6/§4.6). A revoked refresh flips the identity to
   * reauth_required and throws (R4/R7/R19).
   */
  async getUsableAccessToken(args: UsableTokenArgs): Promise<UsableToken> {
    const binding = await this.identities.findByRecruiter(
      args.tenant_id,
      args.connection_id,
      args.recruiter_id,
    );
    if (binding === null) {
      throw new MicrosoftIdentityNotBoundError();
    }
    if (binding.status !== 'active') {
      // disabled / reauth_required / unmapped cannot act (R7).
      throw new MicrosoftReauthRequiredError();
    }
    const key = { tenant_id: args.tenant_id, provider_identity_id: binding.id };
    const bundle = await this.tokenStore.read(key);
    if (bundle === null) {
      await this.identities.setStatus(args.tenant_id, binding.id, 'reauth_required');
      throw new MicrosoftReauthRequiredError();
    }
    if (!tokenNeedsRefresh(bundle, args.nowEpochSeconds)) {
      return {
        access_token: bundle.access_token,
        provider_identity_id: binding.id,
        ms_object_id: binding.provider_user_id,
      };
    }
    let refreshed: DelegatedTokenBundle;
    try {
      const result = await this.oauth.refresh({
        refreshToken: bundle.refresh_token,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        authorityTenant: args.authorityTenant,
      });
      refreshed = this.toBundle(result, args.nowEpochSeconds, bundle);
    } catch (err) {
      if (err instanceof MicrosoftConsentRevokedError) {
        await this.identities.setStatus(args.tenant_id, binding.id, 'reauth_required');
        throw new MicrosoftReauthRequiredError();
      }
      throw err;
    }
    await this.tokenStore.rotate(key, refreshed);
    return {
      access_token: refreshed.access_token,
      provider_identity_id: binding.id,
      ms_object_id: binding.provider_user_id,
    };
  }

  /** C2B-3 revoke/disconnect (R7) — disable the binding + purge custody. */
  async revoke(tenantId: string, connectionId: string, recruiterId: string): Promise<void> {
    const binding = await this.identities.findByRecruiter(tenantId, connectionId, recruiterId);
    if (binding === null) {
      return;
    }
    await this.identities.setStatus(tenantId, binding.id, 'disabled');
    await this.tokenStore.remove({ tenant_id: tenantId, provider_identity_id: binding.id });
  }

  private toBundle(
    result: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
      ms_tenant_id: string;
      ms_object_id: string;
    },
    nowEpochSeconds: number,
    previous?: DelegatedTokenBundle,
  ): DelegatedTokenBundle {
    return {
      access_token: result.access_token,
      // Microsoft may omit a rotated refresh token; keep the prior one (R4).
      refresh_token:
        result.refresh_token.length > 0
          ? result.refresh_token
          : (previous?.refresh_token ?? ''),
      expires_at: nowEpochSeconds + result.expires_in,
      token_type: result.token_type,
      scope: result.scope.length > 0 ? result.scope : (previous?.scope ?? ''),
      // Refresh responses may omit the id_token; keep the bound identity (R6).
      ms_tenant_id: result.ms_tenant_id.length > 0 ? result.ms_tenant_id : (previous?.ms_tenant_id ?? ''),
      ms_object_id: result.ms_object_id.length > 0 ? result.ms_object_id : (previous?.ms_object_id ?? ''),
    };
  }
}
