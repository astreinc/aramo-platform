// Front-Door (Ruling 6) — the deploy-path wall for nginx front-door conf
// semantics. Modeled on the refusal-check family. Asserts, against the template
// and compose AS TEXT, the walls that keep the nginx front door faithful to the
// retired front door's three host classes (ADR-0023), plus the post-flip
// front-door invariant.
//
// Assertions:
//   (a) the webhook route literal from apps/api/src/webhooks/indeed-apply.constants.ts
//       appears in the TENANT block as an exact-match location with
//       `client_max_body_size 3m` — constant/conf parity, both read fresh here.
//   (b) the ADMIN server block contains NO `/v1` location token (R14 negative control).
//   (c) the PORTAL block's only `/v1` location is `/v1/portal/`.
//   (d) all four Ruling-3 header lines are present in each proxied (443) server block.
//   (e) the certbot issuance documentation is WILDCARD-ONLY (contains `-d '*.aramo.ai'`,
//       NOT a bare `-d aramo.ai`) per Ruling 4 / PR-0b R4.
//   (f') post-flip front-door invariant (PR-3, inverting PR-2's inertness (f)):
//       nginx is the live front door — it HAS ports 80/443, NO `profiles:` entry
//       remains anywhere in compose, and no retired-front-door service exists.
//   (g) compose top-level `name: aramo-singlebox` is present (E17 — the pinned
//       project name that kills the directory-name default-project collision).
//   (h) all four NGINX_* entries use the `${VAR:-default}` shape with EXACTLY the
//       Ruling-1 defaults (E19 — always-defined so envsubst never leaves a literal).
//   (i) the nginx command chains through `/docker-entrypoint.sh nginx` (E18 — the
//       inner exec must re-enter the image entrypoint so the template renders).
//   (j) D-ORG-2 T1 topology on the TENANT host: `location /ats/` aliases /srv/ats/
//       with an `/ats/index.html` fallback (ATS deep links + refresh), and the
//       catch-all `location /` roots /srv/home with an `/index.html` fallback
//       (App Home + `/org/*`). The tenant catch-all must NOT root /srv/ats any
//       more (the ATS app never owns the product-neutral host root, §3.A).
//   (k) the Sign host's EXACT /v1 location map (incl. /v1/sign/me/, Aramo Sign Mobile).
//   Aramo Sign Mobile (Native Application Implementation Directive v1.0 LOCKED §4 B-13,
//   §9, §12.12; Amendments M-A1, M-A2 §3):
//   (n) every Sign-host location in SIGN_LIMITS carries `limit_req` in its named zone.
//   (o) `/auth/native/` proxies to auth-service with a body cap.
//   (p) every referenced limit_req zone is defined; refusals are 429.
//   (q) `= /.well-known/apple-app-site-association` and `= /.well-known/assetlinks.json`
//       are exact, application/json, served from the rendered dir, 404 when absent (no
//       redirect / proxy / SPA fallback), cacheable, nosniff; Sign host only.
//   (r) the render wiring: the Dockerfile installs the dedicated entrypoint step, the
//       envsubst filter stays ^NGINX_, the template never references ${SIGN_*}, compose
//       passes the three SIGN_* vars defaulted empty.
//   (s) the render step's behaviour, executed under sh: unset / malformed input ⇒ valid
//       associate-nothing JSON; valid input ⇒ exactly the three M-A2 §3.1 paths.
//
// Negative tests: `--self-test` (also run before every default run) mutates the real
// repo text once per rule above and requires that rule to fire. Set
// FRONTDOOR_SELFTEST_VERBOSE=1 to print each mutation's violations.
//
// PATH-COUPLING (standing lesson): this script references files by literal path.
// Any future move of deploy/nginx/** or the constants file must grep for it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(__dirname, '../..');
const R = (p: string): string => resolve(ROOT, p);

const CONSTANTS = 'apps/api/src/webhooks/indeed-apply.constants.ts';
const TEMPLATE = 'deploy/nginx/templates/aramo.conf.template';
const COMPOSE = 'docker-compose.prod.yml';
const NGINX_CONF = 'deploy/nginx/nginx.conf';
const DOCKERFILE = 'deploy/nginx/Dockerfile';
// Aramo Sign Mobile — the app-association render step (M-A2 §3.2).
const RENDER_SCRIPT = 'deploy/nginx/app-links/render-app-links.sh';
const APP_LINKS_DIR = '/etc/nginx/aramo-app-links';
const ENTRYPOINT_STEP = '/docker-entrypoint.d/40-aramo-app-links.sh';
const APP_LINK_ENV = ['SIGN_IOS_APP_ID', 'SIGN_ANDROID_PACKAGE', 'SIGN_ANDROID_CERT_SHA256S'];
// M-A2 §3.1 — the ONLY paths the app claims on the Sign host.
const AASA_PATHS = ['/s/*', '/d/*', '/auth/native/callback'];

const HEADER_LINES = [
  'proxy_set_header Host',
  'proxy_set_header X-Forwarded-For',
  'proxy_set_header X-Forwarded-Host',
  'proxy_set_header X-Forwarded-Proto',
];

// (n) Sign-host location → its limit_req zone (directive §4 B-13, §9, §12.12).
const SIGN_LIMITS = new Map<string, string>([
  ['/v1/sign/signing/', 'sign_guest'],
  ['/v1/sign/report', 'sign_report'],
  ['/v1/signup/sign/', 'sign_signup'],
  ['/v1/domain-verification/delegate', 'domain_delegate'],
  ['/v1/sign/sender/', 'sign_workspace'],
  ['/v1/sign/billing/', 'sign_workspace'],
  ['/v1/sign/inbox', 'sign_workspace'],
  ['/v1/sign/legal/', 'sign_workspace'],
  ['/v1/sign/account/', 'sign_workspace'],
  ['/v1/sign/me/', 'sign_workspace'],
  ['/auth/', 'sign_auth'],
  ['/auth/native/', 'sign_native_auth'],
]);

interface Issue {
  where: string;
  reason: string;
}

// Extract the balanced-brace body of each `server { … }` block, tagged by which
// NGINX_*_SERVER_NAME (or the port-80 default) it declares.
function serverBlocks(template: string): Array<{ tag: string; body: string }> {
  const out: Array<{ tag: string; body: string }> = [];
  let i = 0;
  while (true) {
    const start = template.indexOf('server {', i);
    if (start === -1) break;
    let depth = 0;
    let j = template.indexOf('{', start);
    const bodyStart = j + 1;
    for (; j < template.length; j++) {
      if (template[j] === '{') depth++;
      else if (template[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = template.slice(bodyStart, j);
    let tag = 'unknown';
    if (body.includes('${NGINX_TENANT_SERVER_NAME}')) tag = 'tenant';
    else if (body.includes('${NGINX_ADMIN_SERVER_NAME}')) tag = 'admin';
    else if (body.includes('${NGINX_PORTAL_SERVER_NAME}')) tag = 'portal';
    else if (body.includes('${NGINX_SIGN_SERVER_NAME}')) tag = 'sign';
    else if (/listen\s+80\b/.test(body)) tag = 'port80';
    out.push({ tag, body });
    i = j + 1;
  }
  return out;
}

// Extract the balanced-brace body of the first `location <header> {` in a block.
function locationBody(blockBody: string, header: string): string | null {
  const idx = blockBody.indexOf(header);
  if (idx === -1) return null;
  const braceStart = blockBody.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  let k = braceStart;
  for (; k < blockBody.length; k++) {
    if (blockBody[k] === '{') depth++;
    else if (blockBody[k] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return blockBody.slice(braceStart, k);
}

// Like locationBody, but the header must be EXACTLY `location <spec> {` — so
// `/auth/` never resolves to `/auth/native/` (or any longer prefix) by accident.
function exactLocationBody(blockBody: string, spec: string): string | null {
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`location\\s+${esc}\\s*\\{`).exec(blockBody);
  if (m === null) return null;
  return locationBody(blockBody.slice(m.index), 'location');
}

function parseWebhookRoute(constantsSrc: string): string | null {
  const m = constantsSrc.match(
    /INDEED_APPLY_WEBHOOK_ROUTE\s*=\s*'([^']+)'/,
  );
  return m ? m[1] : null;
}

// Everything the wall reads, as TEXT. The self-test feeds mutated copies of these
// through the same checks (negative tests), so every check reads only from here.
interface Inputs {
  constantsSrc: string;
  template: string;
  compose: string;
  nginxConf: string;
  dockerfile: string;
  renderScript: string;
}

function readRepoInputs(): Inputs {
  return {
    constantsSrc: readFileSync(R(CONSTANTS), 'utf8'),
    template: readFileSync(R(TEMPLATE), 'utf8'),
    compose: readFileSync(R(COMPOSE), 'utf8'),
    nginxConf: readFileSync(R(NGINX_CONF), 'utf8'),
    dockerfile: readFileSync(R(DOCKERFILE), 'utf8'),
    renderScript: readFileSync(R(RENDER_SCRIPT), 'utf8'),
  };
}

function checkRepo(inputs: Inputs = readRepoInputs()): Issue[] {
  const issues: Issue[] = [];
  const { constantsSrc, template, compose, nginxConf } = inputs;
  // (m) ES-module assets (.mjs, e.g. the pdf.js worker) must be served as JavaScript:
  // the host sends `nosniff`, so an octet-stream .mjs is refused by the browser.
  if (!/types\s*\{[^}]*application\/javascript\s+[^;]*\bmjs\b[^;]*;/.test(nginxConf)) {
    issues.push({ where: 'deploy/nginx/nginx.conf', reason: '(m) .mjs must map to application/javascript (types { application/javascript mjs; })' });
  }

  const blocks = serverBlocks(template);
  const tenant = blocks.find((b) => b.tag === 'tenant');
  const admin = blocks.find((b) => b.tag === 'admin');
  const portal = blocks.find((b) => b.tag === 'portal');
  const sign = blocks.find((b) => b.tag === 'sign');
  // Every proxied 443 block carries the four forwarding headers and the /auth/
  // buffer tuning.
  const ssl = blocks.filter((b) => ['tenant', 'admin', 'portal', 'sign'].includes(b.tag));
  const sslAuth = blocks.filter((b) => ['tenant', 'admin', 'portal', 'sign'].includes(b.tag));

  if (!tenant || !admin || !portal || !sign) {
    issues.push({ where: TEMPLATE, reason: 'missing one of tenant/admin/portal/sign server blocks' });
    return issues;
  }

  // (k) Sign Unified Product S-2 (Aramo-Sign-Unified-Product-Permission-Contract-
  // Platform-API-Directive-v1_0-LOCKED §4.1) — ONE Aramo Sign host. The sign block's
  // /v1 locations are EXACTLY: guest signing, the authenticated sender zone,
  // self-service billing and the recipient inbox (S-7) (sign-service), and public
  // signup (platform-admin) — plus the Domain-Enforcement P3 (LOCKED) §4 named
  // exception: the domain-verification routes and the delegate link (apps/api).
  // Nothing else of apps/api, never the internal envelopes surface. Guest signing and signup
  // are rate-limited; the SPA is /srv/sign; security headers are set host-wide and
  // the guest pages carry their own stricter, uncached policy.
  const SIGN_V1 = new Map<string, string>([
    ['/v1/sign/signing/', 'sign-service:3003'],
    ['/v1/sign/sender/', 'sign-service:3003'],
    ['/v1/sign/billing/', 'sign-service:3003'],
    ['/v1/sign/inbox', 'sign-service:3003'],
    // Personal Free v1.1 §6.4 — "Report this email".
    ['/v1/sign/report', 'sign-service:3003'],
    // Personal Free — legal re-acceptance in the workspace (status / accept).
    ['/v1/sign/legal/', 'sign-service:3003'],
    // Personal Free — the workspace account surface (status / close).
    ['/v1/sign/account/', 'sign-service:3003'],
    // Aramo Sign Mobile (M-A3) — the per-user surface (feed, devices, preferences,
    // saved signature).
    ['/v1/sign/me/', 'sign-service:3003'],
    ['/v1/signup/sign/', 'platform-admin:3002'],
    ['/v1/tenant/domain-verification', 'api:3000'],
    ['/v1/domain-verification/delegate', 'api:3000'],
  ]);
  const signV1 = [...sign.body.matchAll(/location\s+[=~^]*\s*(\/v1[^\s{]*)/g)].map((m) => m[1] ?? '');
  const expected = [...SIGN_V1.keys()];
  if (signV1.length !== expected.length || [...signV1].sort().join('|') !== [...expected].sort().join('|')) {
    issues.push({ where: TEMPLATE, reason: `(k) sign block must expose exactly the /v1 locations ${expected.join(', ')} (found: ${signV1.join(', ') || 'none'})` });
  } else {
    for (const [path, upstream] of SIGN_V1) {
      const loc = exactLocationBody(sign.body, path) ?? '';
      if (!loc.includes(`proxy_pass http://${upstream};`)) issues.push({ where: TEMPLATE, reason: `(k) ${path} must proxy_pass to ${upstream}` });
      if (!/client_max_body_size\s+\d+[mk];/.test(loc)) issues.push({ where: TEMPLATE, reason: `(k) ${path} must set client_max_body_size` });
    }
  }
  // (n) every Sign-host location the app or the web uses is rate-limited at the
  // edge, each in its NAMED zone (directive §4 B-13, §9; §12.12 "nginx limits are
  // active on all app-used locations"). The /v1/tenant/domain-verification
  // exception (apps/api, settings pages only) is the one proxied location left to
  // the upstream's own budgets.
  for (const [path, zone] of SIGN_LIMITS) {
    const loc = exactLocationBody(sign.body, path) ?? '';
    if (!new RegExp(`limit_req\\s+zone=${zone}\\s+burst=\\d+\\s+nodelay;`).test(loc)) {
      issues.push({ where: TEMPLATE, reason: `(n) ${path} must be rate-limited (limit_req zone=${zone} burst=<n> nodelay)` });
    }
  }
  if (!/limit_req_zone\s+\$binary_remote_addr\s+zone=sign_guest:/.test(template) || !/limit_req_zone\s+\$binary_remote_addr\s+zone=sign_signup:/.test(template)) {
    issues.push({ where: TEMPLATE, reason: '(k) the sign_guest and sign_signup limit_req_zone definitions are missing' });
  }
  const signRoot = locationBody(sign.body, 'location / {') ?? '';
  if (!/root\s+\/srv\/sign;/.test(signRoot)) issues.push({ where: TEMPLATE, reason: '(k) sign catch-all `location /` must `root /srv/sign;`' });
  const signServerLevel = sign.body.replace(/^\s*location\b[^{]*\{[^}]*\}/gm, '');
  for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
    if (!new RegExp(`add_header\\s+${h}\\s+"[^"]*"\\s+always;`).test(signServerLevel)) issues.push({ where: TEMPLATE, reason: `(k) sign block must set ${h} host-wide (add_header … always)` });
  }
  // Personal Free — the workspace CSP admits the robot-check origin for scripts
  // and frames, and nothing else third-party beyond fonts.
  const workspaceCsp = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(signServerLevel)?.[1] ?? '';
  for (const d of ['script-src', 'frame-src']) {
    const directive = new RegExp(`${d}\\s+([^;]+)`).exec(workspaceCsp)?.[1] ?? '';
    if (!directive.split(/\s+/).includes('https://challenges.cloudflare.com')) issues.push({ where: TEMPLATE, reason: `(k) sign workspace CSP ${d} must allow https://challenges.cloudflare.com (Personal signup robot check)` });
  }
  const guest = locationBody(sign.body, 'location ~ ^/(s|d)/') ?? '';
  if (guest === '') {
    issues.push({ where: TEMPLATE, reason: '(k) sign block missing the guest-signing location `~ ^/(s|d)/`' });
  } else {
    if (!/root\s+\/srv\/sign;/.test(guest)) issues.push({ where: TEMPLATE, reason: '(k) guest-signing location must `root /srv/sign;`' });
    if (!/try_files\s+\/index\.html\s+=404;/.test(guest)) issues.push({ where: TEMPLATE, reason: '(k) guest-signing location must serve the shell in place (`try_files /index.html =404;`), never an internal redirect that loses its headers' });
    if (!/add_header\s+Cache-Control\s+"no-store"\s+always;/.test(guest)) issues.push({ where: TEMPLATE, reason: '(k) guest-signing pages must be `Cache-Control: no-store`' });
    const csp = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(guest)?.[1] ?? '';
    if (csp === '' || /https?:/.test(csp)) issues.push({ where: TEMPLATE, reason: '(k) guest-signing CSP must exist and allow no third-party origin' });
    for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
      if (!new RegExp(`add_header\\s+${h}\\b`).test(guest)) issues.push({ where: TEMPLATE, reason: `(k) guest-signing location must repeat ${h} (add_header is not inherited)` });
    }
  }
  // (k2) Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED — the
  // retired esign host is gone: its DNS name owns a TXT record only (no address;
  // infrastructure-lightsail/main.tf aws_route53_record.esign_retired), so the
  // front door has no esign server block and never names the retired host.
  if (template.includes('NGINX_ESIGN_SERVER_NAME') || /server_name[^;]*\besign\./.test(template)) {
    issues.push({ where: TEMPLATE, reason: '(k2) the retired esign host must not appear in the front door (no server block, no redirect)' });
  }

  // (o) Aramo Sign Mobile (M-A1) — native authentication reaches auth-service on the
  // Sign host through its own exact prefix, with a body cap.
  const nativeAuth = exactLocationBody(sign.body, '/auth/native/');
  if (nativeAuth === null) {
    issues.push({ where: TEMPLATE, reason: '(o) sign block missing `location /auth/native/` (native authentication, M-A1)' });
  } else {
    if (!nativeAuth.includes('proxy_pass http://auth-service:3001;')) issues.push({ where: TEMPLATE, reason: '(o) /auth/native/ must proxy_pass to auth-service:3001' });
    if (!/client_max_body_size\s+\d+[mk];/.test(nativeAuth)) issues.push({ where: TEMPLATE, reason: '(o) /auth/native/ must set client_max_body_size' });
  }

  // (p) every `limit_req zone=X` names a DEFINED `limit_req_zone … zone=X:`, and a
  // refusal is a 429 (the app renders it as rate limited, never as a server error).
  for (const m of template.matchAll(/limit_req\s+zone=([a-z_]+)/g)) {
    const zone = m[1] ?? '';
    if (!new RegExp(`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${zone}:\\d+m\\s+rate=\\d+r/[sm];`).test(template)) {
      issues.push({ where: TEMPLATE, reason: `(p) limit_req zone=${zone} has no limit_req_zone definition` });
    }
  }
  if (!/^limit_req_status\s+429;/m.test(template)) issues.push({ where: TEMPLATE, reason: '(p) limit_req_status 429; is missing' });

  // (q) M-A2 §3.2 — the two app-association files: EXACT locations on the Sign
  // host, application/json, served from the rendered directory, a 404 when absent
  // (no redirect, never the SPA fallback, never proxied), cacheable, nosniff.
  for (const file of ['apple-app-site-association', 'assetlinks.json']) {
    const loc = exactLocationBody(sign.body, `= /.well-known/${file}`);
    const tag = `(q) /.well-known/${file}`;
    if (loc === null) {
      issues.push({ where: TEMPLATE, reason: `${tag} must be an exact location (\`location = /.well-known/${file}\`) in the sign block` });
      continue;
    }
    if (!/default_type\s+application\/json;/.test(loc)) issues.push({ where: TEMPLATE, reason: `${tag} must set \`default_type application/json;\`` });
    if (!loc.includes(`root ${APP_LINKS_DIR};`)) issues.push({ where: TEMPLATE, reason: `${tag} must \`root ${APP_LINKS_DIR};\` (the rendered files)` });
    if (!loc.includes(`try_files /${file} =404;`)) issues.push({ where: TEMPLATE, reason: `${tag} must \`try_files /${file} =404;\` (a missing file is a 404, never the SPA)` });
    if (/\b(return|rewrite|proxy_pass|alias)\b|index\.html|\$uri/.test(loc)) issues.push({ where: TEMPLATE, reason: `${tag} must not redirect, rewrite, proxy or fall back to the SPA` });
    if (/^\s*types\b/m.test(loc)) issues.push({ where: TEMPLATE, reason: `${tag} must not declare a types block (default_type alone decides; nested braces also break the server-level header scan)` });
    if (!/add_header\s+Cache-Control\s+"public, max-age=\d+"\s+always;/.test(loc)) issues.push({ where: TEMPLATE, reason: `${tag} must set a public Cache-Control (platform verification fetches it)` });
    if (!/add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/.test(loc)) issues.push({ where: TEMPLATE, reason: `${tag} must repeat X-Content-Type-Options nosniff (add_header is not inherited)` });
  }
  // Only the Sign host claims the app: no other server block serves either file.
  for (const b of blocks.filter((x) => x.tag !== 'sign')) {
    if (/apple-app-site-association|assetlinks\.json/.test(b.body)) issues.push({ where: TEMPLATE, reason: `(q) the ${b.tag} block must not serve an app-association file (Sign host only)` });
  }

  // (r) the render wiring: a DEDICATED entrypoint step renders the files at every
  // container start from the three SIGN_* vars; the conf template's envsubst stays
  // filtered to ^NGINX_ and never references them (an unsubstituted ${SIGN_*} would
  // be left literal in the conf).
  const { dockerfile, renderScript } = inputs;
  const nginxSvcEnv = extractComposeService(compose, 'nginx');
  if (!dockerfile.includes(`COPY ${RENDER_SCRIPT} ${ENTRYPOINT_STEP}`)) issues.push({ where: DOCKERFILE, reason: `(r) the runtime image must COPY ${RENDER_SCRIPT} to ${ENTRYPOINT_STEP}` });
  if (!dockerfile.includes(`chmod 0755 ${ENTRYPOINT_STEP}`)) issues.push({ where: DOCKERFILE, reason: `(r) ${ENTRYPOINT_STEP} must be executable (the entrypoint skips non-executable steps)` });
  if (!/^ENV NGINX_ENVSUBST_FILTER=\^NGINX_$/m.test(dockerfile)) issues.push({ where: DOCKERFILE, reason: '(r) NGINX_ENVSUBST_FILTER must stay exactly ^NGINX_' });
  if (/\$\{SIGN_/.test(template)) issues.push({ where: TEMPLATE, reason: '(r) the conf template must not reference ${SIGN_*} (envsubst is filtered to ^NGINX_)' });
  if (!renderScript.includes(`\${ARAMO_APP_LINKS_DIR:-${APP_LINKS_DIR}}`)) issues.push({ where: RENDER_SCRIPT, reason: `(r) the render step must write to ${APP_LINKS_DIR} by default` });
  for (const v of APP_LINK_ENV) {
    if (!renderScript.includes(`\${${v}:-}`)) issues.push({ where: RENDER_SCRIPT, reason: `(r) the render step must read ${v}` });
    if (nginxSvcEnv === null || !nginxSvcEnv.includes(`- ${v}=\${${v}:-}`)) issues.push({ where: COMPOSE, reason: `(r) nginx environment must pass \`${v}=\${${v}:-}\` (optional, defaulted empty)` });
  }

  // (s) the render step's BEHAVIOUR (executed under sh): unset or malformed input
  // renders valid associate-nothing JSON; valid input renders exactly the M-A2 §3.1
  // paths for the one app.
  issues.push(...checkRender(inputs.renderScript));

  // (a) webhook parity — constant appears in the tenant block as an exact-match
  // location carrying client_max_body_size 3m.
  const route = parseWebhookRoute(constantsSrc);
  if (route === null) {
    issues.push({ where: CONSTANTS, reason: 'INDEED_APPLY_WEBHOOK_ROUTE literal not found' });
  } else {
    const loc = `location = ${route}`;
    const idx = tenant.body.indexOf(loc);
    if (idx === -1) {
      issues.push({ where: TEMPLATE, reason: `(a) tenant block missing exact-match "${loc}"` });
    } else {
      // The client_max_body_size 3m must be inside this location's block.
      const braceStart = tenant.body.indexOf('{', idx);
      let depth = 0;
      let k = braceStart;
      for (; k < tenant.body.length; k++) {
        if (tenant.body[k] === '{') depth++;
        else if (tenant.body[k] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const locBody = tenant.body.slice(braceStart, k);
      if (!/client_max_body_size\s+3m\b/.test(locBody)) {
        issues.push({ where: TEMPLATE, reason: '(a) webhook location missing client_max_body_size 3m' });
      }
      if (!/proxy_pass\s+http:\/\/api:3000/.test(locBody)) {
        issues.push({ where: TEMPLATE, reason: '(a) webhook location does not proxy_pass to api:3000' });
      }
    }
  }

  // (j) D-ORG-2 — T1 topology on the tenant host.
  if (tenant) {
    const atsLoc = locationBody(tenant.body, 'location /ats/');
    if (!atsLoc) {
      issues.push({ where: TEMPLATE, reason: '(j) tenant block missing `location /ats/` (ATS SPA under /ats/)' });
    } else {
      if (!/alias\s+\/srv\/ats\/;/.test(atsLoc)) issues.push({ where: TEMPLATE, reason: '(j) `location /ats/` must `alias /srv/ats/;`' });
      if (!/try_files[^;]*\/ats\/index\.html;/.test(atsLoc)) issues.push({ where: TEMPLATE, reason: '(j) `location /ats/` must fall back to /ats/index.html (deep links + refresh)' });
    }
    const rootLoc = locationBody(tenant.body, 'location / ');
    if (!rootLoc) {
      issues.push({ where: TEMPLATE, reason: '(j) tenant block missing the catch-all `location /`' });
    } else {
      if (!/root\s+\/srv\/home;/.test(rootLoc)) issues.push({ where: TEMPLATE, reason: '(j) tenant catch-all `location /` must `root /srv/home;` (App Home), never the ATS SPA' });
      if (/\/srv\/ats/.test(rootLoc)) issues.push({ where: TEMPLATE, reason: '(j) tenant catch-all `location /` references /srv/ats — the ATS app must not own the host root' });
      if (!/try_files[^;]*\/index\.html;/.test(rootLoc)) issues.push({ where: TEMPLATE, reason: '(j) tenant catch-all `location /` must fall back to /index.html (App Home + /org/* client routing)' });
    }
  }

  // (b) admin block — NO `/v1` location token (R14 negative control).
  if (/location\s*=?\s*\/v1/.test(admin.body)) {
    issues.push({ where: TEMPLATE, reason: '(b) admin block contains a /v1 location — R14 violation' });
  }

  // (c) portal block — the only /v1 location is /v1/portal/.
  const portalV1 = [...portal.body.matchAll(/location\s*=?\s*(\/v1\S*)/g)].map((m) => m[1]);
  const badPortal = portalV1.filter((l) => l !== '/v1/portal/');
  if (badPortal.length > 0) {
    issues.push({ where: TEMPLATE, reason: `(c) portal block has non-portal /v1 location(s): ${badPortal.join(', ')}` });
  }
  if (!portalV1.includes('/v1/portal/')) {
    issues.push({ where: TEMPLATE, reason: '(c) portal block missing /v1/portal/ location' });
  }

  // (d) all four header lines present in each 443 server block.
  for (const b of ssl) {
    for (const h of HEADER_LINES) {
      if (!b.body.includes(h)) {
        issues.push({ where: TEMPLATE, reason: `(d) ${b.tag} block missing header "${h}"` });
      }
    }
  }

  // (j) HF1-A regression — every /auth/ location in the three 443 blocks must
  // carry the proxy response-header buffer tuning. Without it the auth callback's
  // large Set-Cookie session JWT overflows nginx's default 4k/8k header buffers
  // and nginx 502s ("upstream sent too big header") before login completes. This
  // assertion fails if the buffer directives are removed from any /auth/ block.
  const AUTH_BUFFERS: Array<[RegExp, string]> = [
    [/proxy_buffer_size\s+32k\b/, 'proxy_buffer_size 32k'],
    [/proxy_buffers\s+8\s+32k\b/, 'proxy_buffers 8 32k'],
    [/proxy_busy_buffers_size\s+64k\b/, 'proxy_busy_buffers_size 64k'],
  ];
  for (const b of sslAuth) {
    const authLoc = exactLocationBody(b.body, '/auth/');
    if (authLoc === null) {
      issues.push({ where: TEMPLATE, reason: `(j) ${b.tag} block missing /auth/ location` });
      continue;
    }
    for (const [re, label] of AUTH_BUFFERS) {
      if (!re.test(authLoc)) {
        issues.push({ where: TEMPLATE, reason: `(j) ${b.tag} /auth/ location missing "${label}" (HF1-A auth-callback buffer tuning)` });
      }
    }
  }

  // (e) certbot issuance documentation — wildcard-only.
  if (!compose.includes("-d '*.aramo.ai'")) {
    issues.push({ where: COMPOSE, reason: "(e) certbot issuance docs missing -d '*.aramo.ai'" });
  }
  if (/-d\s+aramo\.ai(?![.\w*])/.test(compose)) {
    issues.push({ where: COMPOSE, reason: '(e) certbot issuance docs contain a bare -d aramo.ai (apex SAN forbidden — PR-0b R4)' });
  }

  // (f') post-flip front-door invariant — nginx is the live front door (HAS
  // 80/443), NO profiles remain, and the retired front door's service is gone.
  const nginxSvc = extractComposeService(compose, 'nginx');
  const certbotSvc = extractComposeService(compose, 'certbot');
  if (nginxSvc === null) issues.push({ where: COMPOSE, reason: '(f′) nginx service not found' });
  if (certbotSvc === null) issues.push({ where: COMPOSE, reason: '(f′) certbot service not found' });
  if (nginxSvc && !/-\s*['"]80:80['"]/.test(nginxSvc)) {
    issues.push({ where: COMPOSE, reason: "(f′) nginx service missing published port 80:80 (nginx is the live front door)" });
  }
  if (nginxSvc && !/-\s*['"]443:443['"]/.test(nginxSvc)) {
    issues.push({ where: COMPOSE, reason: "(f′) nginx service missing published port 443:443" });
  }
  if (/^\s*profiles:/m.test(compose)) {
    issues.push({ where: COMPOSE, reason: "(f′) a profiles: entry remains — the flip retires all frontdoor profiles" });
  }
  // The retired front door is gone: exactly ONE service publishes each ingress
  // port (nginx). A lingering second front door would double the count. Asserted
  // by port count rather than by a retired service name (keeps this file itself
  // free of the retired-front-door term).
  const p80 = (compose.match(/-\s*['"]80:80['"]/g) ?? []).length;
  const p443 = (compose.match(/-\s*['"]443:443['"]/g) ?? []).length;
  if (p80 !== 1) issues.push({ where: COMPOSE, reason: `(f′) expected exactly one service publishing 80:80, found ${p80}` });
  if (p443 !== 1) issues.push({ where: COMPOSE, reason: `(f′) expected exactly one service publishing 443:443, found ${p443}` });

  // (g) compose top-level project name pinned (E17). Presence of the exact name
  // is what matters (YAML is key-order-insensitive to the engine); the Dockerfile
  // ENV + this pin together make the collision structurally impossible.
  if (!/^name:\s*aramo-singlebox\s*$/m.test(compose)) {
    issues.push({ where: COMPOSE, reason: '(g) top-level `name: aramo-singlebox` not found (E17 project-name pin)' });
  }

  // (h) the four NGINX_* entries use the ${VAR:-default} shape with EXACTLY the
  // Ruling-1 defaults (E19). Exact-string match: a changed default fails the wall.
  const nginxDefaults: Array<[string, string]> = [
    ['NGINX_TENANT_SERVER_NAME', 'localhost'],
    ['NGINX_ADMIN_SERVER_NAME', 'admin.localhost'],
    ['NGINX_PORTAL_SERVER_NAME', 'portal.localhost'],
    ['NGINX_SIGN_SERVER_NAME', 'sign.localhost'],
    ['NGINX_CERT_DIR', '/etc/letsencrypt/live/aramo.ai'],
  ];
  for (const [varName, def] of nginxDefaults) {
    const needle = `${varName}=\${${varName}:-${def}}`;
    if (nginxSvc === null || !nginxSvc.includes(needle)) {
      issues.push({ where: COMPOSE, reason: `(h) nginx environment missing defaulted interpolation "${needle}"` });
    }
  }

  // (i) the nginx command chains through the image entrypoint (E18): the inner
  // exec must be `/docker-entrypoint.sh nginx …`, not a bare `nginx …`.
  if (nginxSvc === null || !nginxSvc.includes('/docker-entrypoint.sh nginx')) {
    issues.push({ where: COMPOSE, reason: '(i) nginx command does not chain through /docker-entrypoint.sh nginx (E18)' });
  }

  return issues;
}

// (s) Executes the render step (the given script TEXT) in a scratch dir and checks
// what it writes. Returns issues; never throws on a script defect.
const FP_A = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0').slice(-2)).join(':');
const FP_B = 'ab:'.repeat(31) + 'cd';
function checkRender(scriptText: string): Issue[] {
  const issues: Issue[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'aramo-app-links-'));
  const script = join(dir, 'render.sh');
  writeFileSync(script, scriptText);
  const render = (label: string, env: Record<string, string>): { aasa: unknown; links: unknown } | null => {
    const out = join(dir, label);
    const base: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ARAMO_APP_LINKS_DIR: out };
    const r = spawnSync('sh', [script], { env: { ...base, ...env }, encoding: 'utf8' });
    if (r.status !== 0) {
      issues.push({ where: RENDER_SCRIPT, reason: `(s) [${label}] the render step exited ${String(r.status)}: ${(r.stderr ?? '').trim().slice(0, 200)}` });
      return null;
    }
    try {
      return {
        aasa: JSON.parse(readFileSync(join(out, 'apple-app-site-association'), 'utf8')) as unknown,
        links: JSON.parse(readFileSync(join(out, 'assetlinks.json'), 'utf8')) as unknown,
      };
    } catch (e) {
      issues.push({ where: RENDER_SCRIPT, reason: `(s) [${label}] the rendered files are missing or not valid JSON (${(e as Error).message})` });
      return null;
    }
  };
  const EMPTY_AASA = { applinks: { details: [] } };
  const expectEmpty = (label: string, env: Record<string, string>): void => {
    const got = render(label, env);
    if (got === null) return;
    if (!isDeepStrictEqual(got.aasa, EMPTY_AASA)) issues.push({ where: RENDER_SCRIPT, reason: `(s) [${label}] apple-app-site-association must associate nothing (got ${JSON.stringify(got.aasa)})` });
    if (!isDeepStrictEqual(got.links, [])) issues.push({ where: RENDER_SCRIPT, reason: `(s) [${label}] assetlinks.json must be [] (got ${JSON.stringify(got.links)})` });
  };
  try {
    expectEmpty('unset', {});
    expectEmpty('malformed', {
      SIGN_IOS_APP_ID: 'ABCDE12345.ai.aramo.sign"],"x":["y',
      SIGN_ANDROID_PACKAGE: 'ai.aramo.sign',
      SIGN_ANDROID_CERT_SHA256S: `${FP_A},not-a-fingerprint`,
    });
    expectEmpty('package-without-certs', { SIGN_ANDROID_PACKAGE: 'ai.aramo.sign' });
    expectEmpty('bad-package', { SIGN_ANDROID_PACKAGE: 'ai.aramo.sign"', SIGN_ANDROID_CERT_SHA256S: FP_A });
    const got = render('valid', {
      SIGN_IOS_APP_ID: 'ABCDE12345.ai.aramo.sign',
      SIGN_ANDROID_PACKAGE: 'ai.aramo.sign',
      SIGN_ANDROID_CERT_SHA256S: ` ${FP_A} , ${FP_B} `,
    });
    if (got !== null) {
      const details = (got.aasa as { applinks?: { details?: Array<{ appIDs?: unknown; components?: Array<Record<string, unknown>> }> } }).applinks?.details ?? [];
      const d0 = details[0];
      if (details.length !== 1 || !isDeepStrictEqual(d0?.appIDs, ['ABCDE12345.ai.aramo.sign'])) {
        issues.push({ where: RENDER_SCRIPT, reason: `(s) [valid] apple-app-site-association must carry exactly one detail for ABCDE12345.ai.aramo.sign (got ${JSON.stringify(got.aasa)})` });
      } else {
        const paths = (d0?.components ?? []).map((c) => c['/']);
        if (!isDeepStrictEqual(paths, AASA_PATHS)) issues.push({ where: RENDER_SCRIPT, reason: `(s) [valid] applinks paths must be exactly ${AASA_PATHS.join(', ')} (got ${JSON.stringify(paths)})` });
        if ((d0?.components ?? []).some((c) => 'exclude' in c || '?' in c || '#' in c)) issues.push({ where: RENDER_SCRIPT, reason: '(s) [valid] applinks components must be plain path matches' });
      }
      const expectLinks = [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'ai.aramo.sign', sha256_cert_fingerprints: [FP_A, FP_B.toUpperCase()] },
      }];
      if (!isDeepStrictEqual(got.links, expectLinks)) issues.push({ where: RENDER_SCRIPT, reason: `(s) [valid] assetlinks.json must be exactly ${JSON.stringify(expectLinks)} (got ${JSON.stringify(got.links)})` });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return issues;
}

// Extract a top-level compose service body (from `  <name>:` to the next
// same-indent `  <key>:` or the `volumes:` block).
function extractComposeService(compose: string, name: string): string | null {
  const lines = compose.split('\n');
  const startRe = new RegExp(`^  ${name}:\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) || /^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// ── Self-test (negative tests): each Aramo Sign Mobile rule must FIRE on a mutation
// of the real repo text that breaks exactly that rule. A fixture string that no
// longer exists fails the self-test itself (the mutation silently stopped testing).
type Mutation = { name: string; tag: string; apply: (i: Inputs) => Inputs };

function swap(text: string, from: string, to: string, name: string): string {
  if (!text.includes(from)) throw new Error(`self-test fixture drift [${name}]: ${JSON.stringify(from.slice(0, 80))} not found`);
  return text.replace(from, to);
}
// Apply `from → to` INSIDE one exact location of the SIGN server block only.
function swapInLocation(template: string, spec: string, from: string, to: string, name: string): string {
  const signAt = template.indexOf('server_name ${NGINX_SIGN_SERVER_NAME};');
  const re = new RegExp(`location\\s+${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g');
  re.lastIndex = signAt;
  const m = signAt === -1 ? null : re.exec(template);
  if (m === null) throw new Error(`self-test fixture drift [${name}]: location ${spec} not found in the sign block`);
  const body = locationBody(template.slice(m.index), 'location') ?? '';
  const start = m.index + template.slice(m.index).indexOf(body);
  return template.slice(0, start) + swap(body, from, to, name) + template.slice(start + body.length);
}
const T = (name: string, tag: string, f: (t: string) => string): Mutation => ({ name, tag, apply: (i) => ({ ...i, template: f(i.template) }) });

function mutations(): Mutation[] {
  const out: Mutation[] = [];
  // (n) — one negative per rate-limited location: drop its limit_req line.
  for (const [path, zone] of SIGN_LIMITS) {
    out.push(T(`unlimited ${path}`, `(n) ${path}`, (t) => swapInLocation(t, path, `limit_req zone=${zone}`, '#limit_req_removed', path)));
  }
  // (n) — the right location in the WRONG zone.
  out.push(T('native auth in the browser zone', '(n) /auth/native/', (t) => swapInLocation(t, '/auth/native/', 'zone=sign_native_auth', 'zone=sign_auth', 'native zone')));
  // (k) — the /v1/sign/me/ location is missing / mis-proxied.
  out.push(T('no /v1/sign/me/', '(k) sign block must expose exactly', (t) => swap(t, 'location /v1/sign/me/ {', 'location /v1/sign/me-gone/ {', 'me')));
  out.push(T('/v1/sign/me/ to api', '(k) /v1/sign/me/ must proxy_pass', (t) => swapInLocation(t, '/v1/sign/me/', 'http://sign-service:3003', 'http://api:3000', 'me upstream')));
  // (o) — native auth missing / mis-proxied / uncapped.
  out.push(T('no /auth/native/', '(o) sign block missing', (t) => swap(t, 'location /auth/native/ {', 'location /auth/nativ/ {', 'native')));
  out.push(T('/auth/native/ to api', '(o) /auth/native/ must proxy_pass', (t) => swapInLocation(t, '/auth/native/', 'http://auth-service:3001', 'http://api:3000', 'native upstream')));
  out.push(T('/auth/native/ uncapped', '(o) /auth/native/ must set client_max_body_size', (t) => swapInLocation(t, '/auth/native/', 'client_max_body_size', '#cmbs', 'native cap')));
  // (p) — a referenced zone with no definition; the 429 status dropped.
  out.push(T('undefined sign_workspace zone', '(p) limit_req zone=sign_workspace', (t) => swap(t, 'zone=sign_workspace:10m', 'zone=sign_workspace_gone:10m', 'zone def')));
  out.push(T('undefined sign_native_auth zone', '(p) limit_req zone=sign_native_auth', (t) => swap(t, 'zone=sign_native_auth:10m', 'zone=other_native:10m', 'zone def')));
  out.push(T('no 429', '(p) limit_req_status 429', (t) => swap(t, 'limit_req_status 429;', 'limit_req_status 503;', 'status')));
  // (q) — one negative per well-known rule, on each file.
  for (const file of ['apple-app-site-association', 'assetlinks.json']) {
    const spec = `= /.well-known/${file}`;
    const tag = `(q) /.well-known/${file}`;
    out.push(T(`${file} prefix not exact`, tag, (t) => swap(t, `location ${spec} {`, `location /.well-known/${file} {`, file)));
    out.push(T(`${file} no json type`, tag, (t) => swapInLocation(t, spec, 'default_type application/json;', 'default_type text/plain;', file)));
    out.push(T(`${file} SPA fallback`, tag, (t) => swapInLocation(t, spec, `try_files /${file} =404;`, 'try_files $uri /index.html;', file)));
    out.push(T(`${file} redirect`, tag, (t) => swapInLocation(t, spec, 'default_type application/json;', 'default_type application/json;\n    return 301 https://$host/;', file)));
    out.push(T(`${file} proxied`, tag, (t) => swapInLocation(t, spec, 'default_type application/json;', 'default_type application/json;\n    proxy_pass http://sign-service:3003;', file)));
    out.push(T(`${file} wrong root`, tag, (t) => swapInLocation(t, spec, `root ${APP_LINKS_DIR};`, 'root /srv/sign;', file)));
    out.push(T(`${file} types block`, tag, (t) => swapInLocation(t, spec, 'default_type application/json;', 'types { }\n    default_type application/json;', file)));
    out.push(T(`${file} no cache policy`, tag, (t) => swapInLocation(t, spec, 'add_header Cache-Control', 'add_header X-Cache-Gone', file)));
    out.push(T(`${file} no nosniff`, tag, (t) => swapInLocation(t, spec, 'add_header X-Content-Type-Options', 'add_header X-Nosniff-Gone', file)));
  }
  out.push(T('AASA on the tenant host', '(q) the tenant block must not serve', (t) => swap(t, '  location = /.well-known/jwks.json {', '  location = /.well-known/apple-app-site-association { return 404; }\n  location = /.well-known/jwks.json {', 'tenant')));
  // (r) — the render wiring.
  out.push({ name: 'render step not installed', tag: '(r) the runtime image must COPY', apply: (i) => ({ ...i, dockerfile: swap(i.dockerfile, `COPY ${RENDER_SCRIPT} ${ENTRYPOINT_STEP}`, '# copy removed', 'dockerfile copy') }) });
  out.push({ name: 'render step not executable', tag: '(r) /docker-entrypoint.d/40-aramo-app-links.sh must be executable', apply: (i) => ({ ...i, dockerfile: swap(i.dockerfile, `chmod 0755 ${ENTRYPOINT_STEP}`, `chmod 0644 ${ENTRYPOINT_STEP}`, 'chmod') }) });
  out.push({ name: 'envsubst filter widened', tag: '(r) NGINX_ENVSUBST_FILTER', apply: (i) => ({ ...i, dockerfile: swap(i.dockerfile, 'ENV NGINX_ENVSUBST_FILTER=^NGINX_', 'ENV NGINX_ENVSUBST_FILTER=^(NGINX|SIGN)_', 'filter') }) });
  out.push(T('template references SIGN_*', '(r) the conf template must not reference', (t) => swap(t, 'default_type application/json;', 'default_type application/json; # ${SIGN_IOS_APP_ID}', 'template var')));
  for (const v of APP_LINK_ENV) {
    out.push({ name: `compose drops ${v}`, tag: `(r) nginx environment must pass \`${v}=`, apply: (i) => ({ ...i, compose: swap(i.compose, `- ${v}=\${${v}:-}`, `- ${v}_GONE=\${${v}:-}`, v) }) });
    out.push({ name: `render ignores ${v}`, tag: `(r) the render step must read ${v}`, apply: (i) => ({ ...i, renderScript: i.renderScript.split(`\${${v}:-}`).join('') }) });
  }
  // (s) — the render step's behaviour.
  out.push({ name: 'render accepts any iOS id', tag: '(s) [malformed] apple-app-site-association', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, "grep -Eq '^[A-Z0-9]{10}", "grep -Eq '^.*|[A-Z0-9]{10}", 'ios regex') }) });
  out.push({ name: 'render drops /d/*', tag: '(s) [valid] applinks paths', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, '{"/":"/d/*","comment":"guest signing link"},', '', 'd path') }) });
  out.push({ name: 'render claims every path', tag: '(s) [valid] applinks paths', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, '{"/":"/s/*"', '{"/":"*"', 's path') }) });
  out.push({ name: 'render keeps a bad fingerprint list', tag: '(s) [malformed] assetlinks.json', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, 'if [ "$bad" -eq 1 ] || [ -z "$fps" ]; then', 'if [ -z "$fps" ]; then', 'fp gate') }) });
  out.push({ name: 'render leaves fingerprints lower-case', tag: '(s) [valid] assetlinks.json', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, " | tr 'abcdef' 'ABCDEF'", '', 'upper') }) });
  out.push({ name: 'render emits invalid JSON when unset', tag: '(s) [unset]', apply: (i) => ({ ...i, renderScript: swap(i.renderScript, "android_json='[]'", "android_json='['", 'json') }) });
  return out;
}

function runSelfTest(): void {
  const base = readRepoInputs();
  const baseIssues = checkRepo(base);
  if (baseIssues.length !== 0) throw new Error(`self-test: the repo itself must pass first (${baseIssues.length} violation(s)): ${JSON.stringify(baseIssues)}`);
  const failures: string[] = [];
  const ms = mutations();
  for (const m of ms) {
    const issues = checkRepo(m.apply(base));
    if (process.env['FRONTDOOR_SELFTEST_VERBOSE'] === '1') console.log(`  [${m.name}] → ${issues.map((i) => i.reason).join(' | ')}`);
    if (!issues.some((i) => i.reason.startsWith(m.tag) || i.reason.includes(m.tag))) {
      failures.push(`[${m.name}] expected a violation matching ${JSON.stringify(m.tag)}; got ${JSON.stringify(issues.map((i) => i.reason))}`);
    }
  }
  if (failures.length > 0) throw new Error(`self-test FAILED — ${failures.length} of ${ms.length} negative test(s) did not fire:\n  ${failures.join('\n  ')}`);
  console.log(`frontdoor:conf-check self-test ok (${ms.length} negative tests fired)`);
}

// Default run: the negative tests first (the wall must still be able to fail), then
// the repo check. `--self-test` runs only the negative tests.
function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    runSelfTest();
    console.log(`frontdoor:conf-check ok (${TEMPLATE} + ${COMPOSE} + ${DOCKERFILE} + ${RENDER_SCRIPT} vs ${CONSTANTS})`);
    return;
  }
  console.error(`frontdoor:conf-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.where}: ${i.reason}`);
  process.exit(1);
}

main();
