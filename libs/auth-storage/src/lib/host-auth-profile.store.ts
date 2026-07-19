import { Injectable } from '@nestjs/common';

import type { HostAuthProfileDto, HostClass } from './dto/host-auth-profile.dto.js';
import { HostAuthProfileRepository } from './host-auth-profile.repository.js';

// Auth-Decoupling PR-1 — the public read surface for the host auth-profile
// registry (exported by AuthStorageModule; the repository stays internal, per
// the RefreshToken convention). The apps/auth-service classifier consumes this.
//
// This is a pure DB read; it does NOT classify (classification mirrors
// deriveBaseFromHost and lives with parseHost in apps/auth-service, §2.2). Any
// read failure surfaces to the caller, which fails open per R-A1-2.
@Injectable()
export class HostAuthProfileStore {
  constructor(private readonly repo: HostAuthProfileRepository) {}

  // Active rows indexed by class. At most one row per class (host_class is
  // UNIQUE); on a duplicate the last write wins (impossible under the seed).
  async activeByClass(): Promise<Map<HostClass, HostAuthProfileDto>> {
    const rows = await this.repo.findAllActive();
    const byClass = new Map<HostClass, HostAuthProfileDto>();
    for (const row of rows) {
      byClass.set(row.host_class, row);
    }
    return byClass;
  }
}
