import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';

import { JwksService, type JwksDocument } from './jwks.service.js';

// §8.6 — GET /.well-known/jwks.json
// Anonymous; Cache-Control: public, max-age=300; single-key JWKS.
@Controller()
export class JwksController {
  constructor(private readonly jwks: JwksService) {}

  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  async getJwks(@Res({ passthrough: true }) _res: Response): Promise<JwksDocument> {
    return this.jwks.getJwks();
  }
}
