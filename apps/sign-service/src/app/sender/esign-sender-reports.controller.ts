import { Controller, Get, Query, StreamableFile, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';

import { senderHttp } from './envelope-contracts.js';
import { SenderReportsService, type CsvExport, type ReportQuery } from './sender-reports.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED, 2bd74ca5) §1.13 — the sender's
// organization REPORTS (basic). Same authenticated SENDER zone as EsignSenderController
// (EsignSenderBoundary: JwtAuthGuard → `sign` consumer → `sign` capability → scope):
//
//   GET v1/sign/sender/reports/overview            sign:report:read   (JSON)
//   GET v1/sign/sender/reports/export              sign:report:read   (text/csv; ?report=summary|volume|senders|templates)
//   GET v1/sign/sender/reports/envelopes/export    sign:report:read   (text/csv; envelope audit export)
//
// Every route is refused while the `sign.reports` plan capability is not available
// (ESIGN_FEATURE_NOT_AVAILABLE, 403) and for a PERSONAL tenant. Read-only; tenant_id comes
// only from the verified auth context. Query: from, to (YYYY-MM-DD, inclusive, UTC), period.
@Controller('v1/sign/sender/reports')
@UseFilters(AramoExceptionFilter)
export class EsignSenderReportsController {
  constructor(private readonly reports: SenderReportsService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  private static csv(out: CsvExport): StreamableFile {
    return new StreamableFile(Buffer.from(out.body, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${out.filename}"`,
    });
  }

  @Get('overview')
  @EsignSenderBoundary(ESIGN_SCOPE.REPORT_READ)
  overview(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query() query: ReportQuery) {
    return this.run(requestId, () => this.reports.overview(auth, query ?? {}, requestId));
  }

  @Get('export')
  @EsignSenderBoundary(ESIGN_SCOPE.REPORT_READ)
  async export(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query() query: ReportQuery): Promise<StreamableFile> {
    return EsignSenderReportsController.csv(await this.run(requestId, () => this.reports.exportCsv(auth, query ?? {}, requestId)));
  }

  @Get('envelopes/export')
  @EsignSenderBoundary(ESIGN_SCOPE.REPORT_READ)
  async auditExport(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query() query: ReportQuery): Promise<StreamableFile> {
    return EsignSenderReportsController.csv(await this.run(requestId, () => this.reports.auditExport(auth, query ?? {}, requestId)));
  }
}
