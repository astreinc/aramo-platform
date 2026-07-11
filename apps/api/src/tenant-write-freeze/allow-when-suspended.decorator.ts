import { SetMetadata } from '@nestjs/common';

// Inc-3 PR-3.7 — the write-freeze escape hatch.
//
// @AllowWhenSuspended() marks a route (handler or controller class) as permitted
// to WRITE even when its tenant is SUSPENDED or CLOSED. TenantWriteFreezeInterceptor
// reads this via Reflector.getAllAndOverride and skips its lifecycle check (rung 4).
//
// SHIPS APPLIED TO ZERO ROUTES BY DESIGN. The tenant surface has no self-service
// reactivation — a suspended tenant's users are frozen out of writes, full stop.
// The decorator exists so that the day a write-through-suspension route IS ruled
// (e.g. a future "acknowledge suspension" acceptance), the mechanism is already
// here; its FIRST application requires its own directive.
export const ALLOW_WHEN_SUSPENDED_KEY = 'aramo:allow_when_suspended';

export const AllowWhenSuspended = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WHEN_SUSPENDED_KEY, true);
