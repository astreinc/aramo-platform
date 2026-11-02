// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.1 — the official PDF of a fixed
// form is uploaded as JSON { content_base64 }. The PDF may be 10 MB (~13.4 MB as base64), above
// the global JSON parser's 100 kB default, so main.ts mounts a route-scoped JSON parser with
// this limit for this path ONLY (before the global parser). The 10 MB rule itself is enforced
// on the decoded bytes (422 pdf_too_large). The edge carries the same cap
// (deploy/nginx/templates/aramo.conf.template, admin host).
export const FIXED_FORM_PDF_UPLOAD_ROUTE = '/platform/document-templates/versions/:versionId/fixed-form/pdf';
export const FIXED_FORM_PDF_UPLOAD_MAX_BODY = '15mb';
