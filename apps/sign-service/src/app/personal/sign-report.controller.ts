import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import type { Request } from 'express';

import { clientIp } from './personal-send.gate.js';
import { type ReportBody, type ReportOutcome, SignReportService } from './sign-report.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 — "Report this email".
// PUBLIC (no session): the recipient's own signing token is the only authority,
// and it can only file one report about its own envelope. Bounded per client
// address at the nginx edge and in the service.
@Controller('v1/sign/report')
@UseFilters(AramoExceptionFilter)
export class SignReportController {
  constructor(private readonly reports: SignReportService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  report(@Body() body: ReportBody, @Req() req: Request, @RequestId() requestId: string): Promise<ReportOutcome> {
    return this.reports.submit(body ?? {}, clientIp(req), requestId);
  }
}
