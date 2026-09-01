import { Injectable } from '@nestjs/common';

import type { AuthorizationScopeCache } from './scope-cache.port.js';

// HF-AUTH-1 — a per-process in-memory implementation of the scope-snapshot cache.
//
// Used as the DEFAULT binding (when no Redis-backed cache is provided) and by the
// test-auth harness. It preserves the port's semantics exactly: bounded TTL,
// version-keyed immutable entries. In a multi-instance deployment a Redis adapter
// replaces it at the app composition root so the snapshot is shared; the resolver
// logic (version match, canonical-RBAC fallback, fail-closed) is identical either
// way. Because entries are version-keyed and versions are monotonic, a stale
// per-process entry can never serve OLD scopes for a CURRENT version — the resolver
// only reads the key for the version it already confirmed is current.
@Injectable()
export class InMemoryScopeCache implements AuthorizationScopeCache {
  private readonly store = new Map<string, { scopes: string[]; expiresAtMs: number }>();

  async get(key: string): Promise<string[] | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.store.delete(key);
      return null;
    }
    return [...entry.scopes];
  }

  async set(key: string, scopes: string[], ttlSeconds: number): Promise<void> {
    this.store.set(key, { scopes: [...scopes], expiresAtMs: this.nowMs() + ttlSeconds * 1000 });
  }

  // Injectable seam kept explicit so a test can pin the clock if needed; production
  // reads the wall clock.
  protected nowMs(): number {
    return Date.now();
  }
}
