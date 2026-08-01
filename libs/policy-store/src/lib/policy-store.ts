import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PolicyEngineError, validatePackage, type PolicyPackage } from '@aramo/policy-engine';

import type { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';
import { checksumMatches, computeChecksum } from './checksum.js';
import { isEffectiveAt, selectEffectiveAt } from './window.js';
import { PolicyStoreError } from './errors.js';
import type { PublishPolicyVersionInput, ResolvedPolicyVersion } from './types.js';

// The policy-store surface (ADR-0024 §D7 / §D17b): definition storage,
// versioning, publication, tenant retrieval, caching. It never evaluates a
// policy — it never inspects a rule or produces a decision; the stored
// definition is an opaque, checksummed PolicyPackage that a later consumer
// (the engine) evaluates.
//
// @Injectable so a future PR can wire it via DI; this library itself ships
// no NestJS module/controller/endpoint and no consumers (PR-2 prohibition).
// Tests and callers construct it directly with a PrismaService.

interface StoredRow {
  id: string;
  tenant_id: string;
  package_name: string;
  version: string;
  definition: Prisma.JsonValue;
  checksum: string;
  effective_from: Date;
  effective_to: Date | null;
  published_by: string;
  published_at: Date;
}

// ADR-0024 PR-4d — the active-version cache carries a TTL so a version published
// by the seed or ANOTHER instance becomes effective on a RUNNING api within a
// bounded window. Publish-time eviction still makes the publishing instance
// immediate; the TTL bounds every other reader. Env-overridable (tests); a TTL
// of 0 (a query per decision, defeating the cache) or unbounded (the
// stale-forever defect) is REJECTED at construction.
const DEFAULT_CACHE_TTL_MS = 30_000;
const MIN_CACHE_TTL_MS = 1; // the floor — anything <= 0 or non-finite is invalid

function resolveCacheTtlMs(): number {
  const raw = process.env['ARAMO_POLICY_CACHE_TTL_MS'];
  if (raw === undefined || raw === '') return DEFAULT_CACHE_TTL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < MIN_CACHE_TTL_MS) {
    throw new Error(
      `ARAMO_POLICY_CACHE_TTL_MS must be a finite number >= ${MIN_CACHE_TTL_MS}ms — a TTL of 0 or unbounded reintroduces the cache-staleness defect (got "${raw}")`,
    );
  }
  return ms;
}

interface CachedVersion {
  readonly value: ResolvedPolicyVersion;
  readonly cachedAt: number;
}

@Injectable()
export class PolicyStore {
  // Cache of the current active version per (tenant, package). A hit is served
  // only if it is BOTH still window-effective at the present instant AND younger
  // than the TTL; otherwise it is re-read from the DB. Every publish evicts the
  // key on THIS instance (immediate for the publisher). The TTL bounds staleness
  // for a version published elsewhere (seed / another instance).
  private readonly currentCache = new Map<string, CachedVersion>();
  private readonly ttlMs = resolveCacheTtlMs();
  private readonly logger = new Logger(PolicyStore.name);

  constructor(private readonly prisma: PrismaService) {}

  private static cacheKey(tenantId: string, packageName: string): string {
    return `${tenantId}::${packageName}`;
  }

  private static toResolved(row: StoredRow): ResolvedPolicyVersion {
    if (!checksumMatches(row.definition, row.checksum)) {
      throw new PolicyStoreError(
        'CHECKSUM_MISMATCH',
        `Stored policy version ${row.tenant_id}/${row.package_name}@${row.version} failed its integrity check`,
      );
    }
    return {
      tenant_id: row.tenant_id,
      package_name: row.package_name,
      version: row.version,
      definition: row.definition as unknown as PolicyPackage,
      checksum: row.checksum,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      published_by: row.published_by,
      published_at: row.published_at,
    };
  }

  /**
   * Publish a new immutable version of a policy package. Closes the current
   * open version's window at the new effective_from and inserts the new
   * version as the open one. A published version is never mutated;
   * re-publishing a version string that already exists is rejected.
   */
  async publish(input: PublishPolicyVersionInput): Promise<ResolvedPolicyVersion> {
    const pkg = input.definition;

    // PR-2 RULING — shape validation only, delegated to the engine's
    // validatePackage. This library never calls evaluate/compose and never
    // produces a decision; validatePackage inspects only the package's
    // structure (registry allowlist, default_disposition, well-formed rules).
    // An invalid package is rejected before any write, carrying the engine's
    // rejection reason.
    try {
      validatePackage(pkg);
    } catch (err) {
      if (err instanceof PolicyEngineError) {
        throw new PolicyStoreError(
          'INVALID_PACKAGE',
          `Package "${pkg.name}" rejected at publish: ${err.message}`,
        );
      }
      throw err;
    }

    const packageName = pkg.name;
    const effectiveFrom = input.effective_from ?? new Date();
    const checksum = computeChecksum(pkg);

    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.storedPolicyVersion.findFirst({
        where: { tenant_id: input.tenant_id, package_name: packageName, version: pkg.version },
        select: { id: true },
      });
      if (existing) {
        throw new PolicyStoreError(
          'VERSION_ALREADY_EXISTS',
          `Policy version ${input.tenant_id}/${packageName}@${pkg.version} is already published and is immutable; publish a new version`,
        );
      }

      const open = await tx.storedPolicyVersion.findFirst({
        where: { tenant_id: input.tenant_id, package_name: packageName, effective_to: null },
        select: { id: true, effective_from: true },
      });
      if (open) {
        if (effectiveFrom.getTime() <= open.effective_from.getTime()) {
          throw new PolicyStoreError(
            'INVALID_EFFECTIVE_FROM',
            `effective_from ${effectiveFrom.toISOString()} must be strictly after the current open version's effective_from ${open.effective_from.toISOString()}`,
          );
        }
        await tx.storedPolicyVersion.update({
          where: { id: open.id },
          data: { effective_to: effectiveFrom },
        });
      }

      return tx.storedPolicyVersion.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          package_name: packageName,
          version: pkg.version,
          definition: pkg as unknown as Prisma.InputJsonValue,
          checksum,
          effective_from: effectiveFrom,
          effective_to: null,
          published_by: input.published_by,
        },
      });
    });

    this.currentCache.delete(PolicyStore.cacheKey(input.tenant_id, packageName));
    return PolicyStore.toResolved(created as StoredRow);
  }

  /**
   * Retrieve the policy version active at `at` (default: now) for one tenant
   * + package, or null if none is active. The current-instant lookup is
   * cached; historical lookups always read through.
   */
  async getActiveVersion(
    tenantId: string,
    packageName: string,
    at?: Date,
  ): Promise<ResolvedPolicyVersion | null> {
    const isCurrent = at === undefined;
    const instant = at ?? new Date();

    if (isCurrent) {
      const cached = this.currentCache.get(PolicyStore.cacheKey(tenantId, packageName));
      if (cached && isEffectiveAt(cached.value, instant) && Date.now() - cached.cachedAt <= this.ttlMs) {
        return cached.value;
      }
    }

    const rows = (await this.prisma.storedPolicyVersion.findMany({
      where: { tenant_id: tenantId, package_name: packageName },
    })) as StoredRow[];

    const active = selectEffectiveAt(rows, instant);
    if (!active) return null;

    const resolved = PolicyStore.toResolved(active);
    if (isCurrent) {
      this.currentCache.set(PolicyStore.cacheKey(tenantId, packageName), { value: resolved, cachedAt: Date.now() });
      // Inspectability (PR-4d): the in-force version is answerable at runtime
      // from the log, without a DB query.
      this.logger.log(
        `policy cache load: tenant=${tenantId} package=${packageName} version=${resolved.version} checksum=${resolved.checksum}`,
      );
    }
    return resolved;
  }

  /** Retrieve a specific published version, or null if it does not exist. */
  async getVersion(
    tenantId: string,
    packageName: string,
    version: string,
  ): Promise<ResolvedPolicyVersion | null> {
    const row = (await this.prisma.storedPolicyVersion.findFirst({
      where: { tenant_id: tenantId, package_name: packageName, version },
    })) as StoredRow | null;
    if (!row) return null;
    return PolicyStore.toResolved(row);
  }

  /**
   * List all published versions for one tenant + package, newest window
   * first. Tenant isolation is enforced by the tenant_id predicate — no
   * other tenant's rows are returned.
   */
  async listVersions(tenantId: string, packageName: string): Promise<ResolvedPolicyVersion[]> {
    const rows = (await this.prisma.storedPolicyVersion.findMany({
      where: { tenant_id: tenantId, package_name: packageName },
      orderBy: { effective_from: 'desc' },
    })) as StoredRow[];
    return rows.map((row) => PolicyStore.toResolved(row));
  }
}
