// CCP Billing Products Directive v1.0 (LOCKED) BP-7 — the Apple review screenshot upload route and its
// body cap (an image of up to 8 MB as base64 is about 10.7 MB). The nginx location for this route
// carries the same cap (deploy/nginx/templates/aramo.conf.template).
export const BILLING_ASSET_UPLOAD_ROUTE = '/platform/commercial/catalog/plans/:planId/billing-assets/apple-review-screenshot';
export const BILLING_ASSET_UPLOAD_MAX_BODY = '12mb';
