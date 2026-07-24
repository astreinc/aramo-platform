import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ContactDto } from './dto/contact.dto.js';
import { WorkspaceRequestDto } from './dto/workspace-request.dto.js';
import { loadIntakeConfig } from './intake.config.js';
import { IntakeMailerService } from './intake-mailer.service.js';
import { RateLimitService } from './rate-limit.service.js';

@Controller('intake')
export class IntakeController {
  private readonly config = loadIntakeConfig();

  constructor(
    @Inject(IntakeMailerService)
    private readonly mailer: IntakeMailerService,
    @Inject(RateLimitService)
    private readonly rateLimiter: RateLimitService,
  ) {}

  @Get('healthz')
  healthz(@Res() res: Response): void {
    res.status(200).json({ ok: true });
  }

  @Post('workspace-request')
  async workspaceRequest(
    @Body() dto: WorkspaceRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle(dto.website, req, res, () =>
      this.mailer.sendWorkspaceRequest(dto),
    );
  }

  @Post('contact')
  async contact(
    @Body() dto: ContactDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle(dto.website, req, res, () =>
      this.mailer.sendContact(dto),
    );
  }

  private async handle(
    honeypot: string | undefined,
    req: Request,
    res: Response,
    send: () => Promise<void>,
  ): Promise<void> {
    const wantsHtml = (req.headers['accept'] ?? '').includes('text/html');

    // Honeypot: a filled `website` field means a bot. Drop silently (204, no
    // send) so the bot believes it succeeded; do not consume a rate token.
    if (honeypot !== undefined && honeypot.trim() !== '') {
      res.status(204).end();
      return;
    }

    // Per-IP rate limit, keyed on nginx's X-Real-IP (falls back to req.ip).
    const header = req.headers['x-real-ip'];
    const ip = (Array.isArray(header) ? header[0] : header) ?? req.ip ?? 'unknown';
    if (!this.rateLimiter.tryConsume(ip)) {
      if (wantsHtml) {
        res.redirect(303, `${this.config.baseUrl}/thanks?err=1`);
        return;
      }
      res.status(429).json({ ok: false });
      return;
    }

    // The email is the record. On SES failure, surface a generic 502 (JSON) or
    // an error redirect (HTML) — never the AWS error detail.
    try {
      await send();
    } catch {
      if (wantsHtml) {
        res.redirect(303, `${this.config.baseUrl}/thanks?err=1`);
        return;
      }
      throw new HttpException({ ok: false }, HttpStatus.BAD_GATEWAY);
    }

    if (wantsHtml) {
      res.redirect(303, `${this.config.baseUrl}/thanks`);
      return;
    }
    res.status(200).json({ ok: true });
  }
}
