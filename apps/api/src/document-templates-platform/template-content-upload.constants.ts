// TEMPLATE-CONTENT-2 (Aramo-Template-Content-2-Directive-v1_0-LOCKED) C-7 — editable template
// content may be up to 256 KiB (rtr-html-v2), above the global JSON parser's 100 kB default, so
// main.ts mounts a route-scoped JSON parser with this limit for the template VERSION WRITE
// routes only (before the global parser). Every other route keeps the default. The edge
// carries a matching cap (deploy/nginx/templates/aramo.conf.template, admin + tenant hosts);
// the Sign Personal studio routes are internal (sign-service → api) and need no edge change.
export const TEMPLATE_CONTENT_WRITE_MAX_BODY = '1mb';

const TEMPLATE_CONTENT_WRITE_PATHS: readonly RegExp[] = [
  // Platform console: create a draft version / update a draft version.
  /^\/platform\/document-templates\/[^/]+\/versions\/?$/,
  /^\/platform\/document-templates\/versions\/[^/]+\/?$/,
  // Tenant (Org Home): the same two writes.
  /^\/v1\/document-templates\/[^/]+\/versions\/?$/,
  /^\/v1\/document-templates\/versions\/[^/]+\/?$/,
  // Sign Personal studio (internal, from sign-service).
  /^\/v1\/documents\/esign\/templates\/studio\/[^/]+\/versions\/?$/,
  /^\/v1\/documents\/esign\/templates\/studio\/versions\/[^/]+\/?$/,
];

/** Whether a request writes template version content (POST / PATCH on the routes above). */
export function isTemplateContentWrite(method: string, path: string): boolean {
  return (method === 'POST' || method === 'PATCH') && TEMPLATE_CONTENT_WRITE_PATHS.some((re) => re.test(path));
}
