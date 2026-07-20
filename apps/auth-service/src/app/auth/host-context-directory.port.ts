// Auth-Decoupling PR-5a (ADR-0021 §2). Auth's OWN host→context resolver port.
// Auth passes a HOST, not a slug (R-P5a-1): the adapter owns slug extraction, so
// auth never imports extractTenantSlugFromHost and never knows APP_ROOT_DOMAIN
// semantics or what a "tenant slug" is.
//
// A NON-NULL result means "this host resolves to an active context" — exactly the
// isTenantHost predicate deriveBaseFromHost consumes. `identity_provider` carries
// the Home-Realm-Discovery hint unchanged. The port is self-contained (no Aramo
// import) so the §4.5 sweep passes and 5b can move it behind the scope:auth wall.
export interface HostContext {
  context_id: string;
  identity_provider: string | null;
}

export const HOST_CONTEXT_DIRECTORY = 'HOST_CONTEXT_DIRECTORY';

export interface HostContextDirectory {
  // Null on miss OR error (R-P5a-4 fail-open) — the adapter never throws where the
  // old code returned null.
  resolveByHost(host: string): Promise<HostContext | null>;
}
