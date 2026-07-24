import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { loadIntakeConfig } from './intake.config.js';

// Response semantics for thrown errors (§1.6). For an HTML form post (no JS),
// any error redirects to ${PUBLIC_SITE_BASE_URL}/thanks?err=1. For an island
// (JSON), it returns the status with a minimal body. AWS/SES error detail is
// NEVER surfaced — the message is generic.
@Catch()
export class IntakeExceptionFilter implements ExceptionFilter {
  private readonly config = loadIntakeConfig();

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const wantsHtml = (req.headers['accept'] ?? '').includes('text/html');

    if (wantsHtml) {
      res.redirect(303, `${this.config.baseUrl}/thanks?err=1`);
      return;
    }

    res.status(status).json({ ok: false });
  }
}
