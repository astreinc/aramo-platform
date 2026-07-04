import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { TalentRecordView } from '@aramo/talent-record';
import { SubjectMatcherService } from '@aramo/talent-trust';
import type { Request } from 'express';
import { from, of, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { TalentAnchorProducerService } from './talent-anchor-producer.service.js';

// TR-2a-1 — the WRITE-TIME anchor hook. A global APP_INTERCEPTOR (mirrors
// TalentRecordEnrichmentInterceptor) route-guarded to the talent-record WRITE
// routes. On a successful create/update it records the record's identifier
// anchors into the trust ledger via the producer — apps/api orchestration ABOVE
// the I15 wall (the lib controller is untouched; talent_trust never imports
// talent-record).
//
// TR-2a-3 (R7) — after recording anchors, it invokes the TR-2a-2 matcher for that
// subject so fresh same-human ADVISORIES surface at write time (not only on the
// backfill sweep). Advise-only: the matcher writes advisories, never merges. Both
// steps reuse THIS existing seam (no new structure) and stay above the wall.
//
// Best-effort: anchor recording AND matching MUST NOT fail the talent write. On
// any error we log and pass the original response through — the backfills
// reconcile any miss (all of it is idempotent, so this is safe). The work is
// awaited (not fire-and-forget) so a fresh write's anchors + advisories are
// present by the time the caller could read them, and so the integration tests
// are deterministic.
type WriteRequest = Request & { method: string };

const CREATE_PATH = '/v1/talent-records';
const UPDATE_PATH = '/v1/talent-records/:id';

@Injectable()
export class TalentAnchorInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TalentAnchorInterceptor.name);

  constructor(
    private readonly producer: TalentAnchorProducerService,
    private readonly matcher: SubjectMatcherService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<WriteRequest>();
    const path = req.route?.path;
    const isWrite =
      (req.method === 'POST' && path === CREATE_PATH) ||
      (req.method === 'PATCH' && path === UPDATE_PATH);

    return next.handle().pipe(
      switchMap((value) => {
        if (!isWrite || value === null || typeof value !== 'object') {
          return of(value);
        }
        const view = value as Partial<TalentRecordView>;
        if (typeof view.id !== 'string' || typeof view.tenant_id !== 'string') {
          return of(value);
        }
        return from(
          this.producer
            .recordAnchorsForView(view as TalentRecordView)
            // TR-2a-3 (R7) — surface fresh same-human advisories for this subject.
            // matchForRef resolves the subject via the ATS_TALENT_RECORD ref the
            // producer just wrote; advise-only, so it never merges.
            .then(() =>
              this.matcher.matchForRef(view.tenant_id!, 'ATS_TALENT_RECORD', view.id!),
            )
            .then(() => value)
            .catch((err: unknown) => {
              // Non-blocking: the write already succeeded; the backfills will
              // reconcile. Surface the failure in logs, never to the caller.
              this.logger.error(
                `anchor producer/matcher failed for talent_record ${view.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return value;
            }),
        );
      }),
    );
  }
}
