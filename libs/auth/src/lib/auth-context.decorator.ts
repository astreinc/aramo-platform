import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthContext as AuthContextType } from './auth-context.types.js';

// @AuthContext() — extracts request.authContext set by JwtAuthGuard.
// Throwing path is in the guard; this decorator trusts the guard ran.
export const AuthContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContextType => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContextType }>();
    if (!request.authContext) {
      throw new Error(
        'AuthContext missing on request — JwtAuthGuard must run before this decorator',
      );
    }
    return request.authContext;
  },
);
