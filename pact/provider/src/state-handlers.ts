// PR-M0R-1 Pact provider state handlers.
//
// Per directive §4: "state-setup handlers for the 6 auth interactions plus
// inherited consent baseline states."
//
// Per PR-M0R-1 Directive Amendment v1.0 §2.3: state setup happens via test
// fixtures and auth-helpers.ts test-token issuance — NOT via HTTP calls
// to apps/api. If a future state handler finds it needs apps/api, halt
// and surface.
//
// For PR-M0R-1's minimum-viable interaction set, the named states are
// all environment-only (env vars are already wired at module load) and
// require no per-interaction setup. The structure is in place so follow-on
// PRs can extend with refresh-token seeding (via libs/auth-storage's
// RefreshTokenService) and access-cookie seeding (via auth-helpers'
// issueTestAccessToken) without restructuring this file.

export type StateHandler = () => Promise<void>;

export interface StateHandlerMap {
  [stateName: string]: StateHandler;
}

// The named states must match the .given(...) strings used in
// pact/consumers/auth-service-consumer/src/auth.consumer.test.ts exactly.
export const stateHandlers: StateHandlerMap = {
  'AUTH_PRIVATE_KEY is configured': async () => {
    // Asserted at verify.ts bootstrap (env var must be set before the
    // provider Nest app starts). No per-interaction setup required.
    return undefined;
  },
  'Cognito env vars are configured': async () => {
    // Same as above — env vars set at bootstrap. /login does not perform
    // a Cognito HTTP call (it only builds the authorize URL), so no
    // network mock is needed for this interaction.
    return undefined;
  },
  'no setup required': async () => {
    // Error-case interactions verify the provider's failure paths with no
    // prior state. Explicit no-op so the verifier finds the named state
    // rather than reporting "state handler not found."
    return undefined;
  },
};
