import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { FEATURE_AVAILABILITY, isFeatureAvailable, type FeatureAvailability } from '@aramo/subscription';

// DOC-TEMPLATE-LIB-1 T-5 (Implementation Directive v1.0 LOCKED §7.4) — Sign plan
// capabilities that are entitled in the catalog but gated by LAUNCH AVAILABILITY
// (libs/subscription feature-availability, Commercial Plans Amendment A1 review). A
// capability that is NOT_AVAILABLE is never served: its routes refuse with
// ESIGN_FEATURE_NOT_AVAILABLE (403) and the sender context reports it unavailable so the
// console shows the unavailable treatment. Moving `sign.templates` to AVAILABLE is a PO
// commercial decision at activation — never made here.
//
// The registry is injectable (SIGN_FEATURE_REGISTRY) only so tests can exercise both
// states; production always reads FEATURE_AVAILABILITY.

export const SIGN_FEATURE_REGISTRY = 'SIGN_FEATURE_REGISTRY';
export const SIGN_TEMPLATES_FEATURE = 'sign.templates';

@Injectable()
export class SignFeatureGate {
  private readonly registry: Readonly<Record<string, FeatureAvailability>>;

  constructor(@Optional() @Inject(SIGN_FEATURE_REGISTRY) registry?: Readonly<Record<string, FeatureAvailability>>) {
    this.registry = registry ?? FEATURE_AVAILABILITY;
  }

  isAvailable(feature_key: string): boolean {
    return isFeatureAvailable(feature_key, this.registry);
  }

  assertAvailable(feature_key: string, requestId: string): void {
    if (!this.isAvailable(feature_key)) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, {
        requestId,
        details: { feature_key },
      });
    }
  }
}
