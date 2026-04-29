import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// @RequestId() — extracts request.requestId set by RequestIdMiddleware.
export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request & { requestId?: string }>();
    return request.requestId ?? 'unknown';
  },
);
