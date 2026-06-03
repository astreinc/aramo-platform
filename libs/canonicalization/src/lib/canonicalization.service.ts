import { Injectable } from '@nestjs/common';

import {
  CanonicalizationRepository,
  type CanonicalizeInput,
  type CanonicalizeResult,
} from './canonicalization.repository.js';

// T2-2a — CanonicalizationService is a thin service-layer wrapper over
// CanonicalizationRepository.canonicalize. The orchestration (the atomic
// $transaction over 4 schemas) lives in the repository per the
// libs/submittal precedent (Lead M5 PR-3 Ruling 2 — "minimal orchestration
// belongs in the repository when cross-schema reads/writes coexist in one
// $transaction"). The service exists to:
//   1. Provide a stable @Injectable surface the T2-3 ingestion trigger
//      can DI without coupling to repository internals.
//   2. Form the canonical Nest module export shape (mirroring TalentService
//      / ConsentService / SubmittalService — the repo stays internal at
//      the lib level, the service is the public surface, the
//      Module.exports declaration on canonicalization.module.ts wires it).
//
// Service-only (no HTTP route at T2-2a per Directive §3 / §6). The
// PR-10 precedent: a service with no controller. T2-3 wires the trigger
// from libs/ingestion (cross-lib service injection).
@Injectable()
export class CanonicalizationService {
  constructor(private readonly repo: CanonicalizationRepository) {}

  async canonicalize(input: CanonicalizeInput): Promise<CanonicalizeResult> {
    return this.repo.canonicalize(input);
  }
}
