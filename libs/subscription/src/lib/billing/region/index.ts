// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.1, §4.4, §5, §6 — the billing region model.
export * from './billing-region.view.js';
export * from './billing-country.port.js';
export { regionEnableRefusal, registrationErrors, billingRegionChangeErrors, GSTIN_PATTERN, PAN_PATTERN } from './region-guard.js';
export { BillingRegionService, BillingRegionChangeError, BillingRegionIntegrityError } from './billing-region.service.js';
