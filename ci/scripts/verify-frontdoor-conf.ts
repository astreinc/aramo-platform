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
//
// PATH-COUPLING (standing lesson): this script references files by literal path.
// Any future move of deploy/nginx/** or the constants file must grep for it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const R = (p: string): string => resolve(ROOT, p);

const CONSTANTS = 'apps/api/src/webhooks/indeed-apply.constants.ts';
const TEMPLATE = 'deploy/nginx/templates/aramo.conf.template';
const COMPOSE = 'docker-compose.prod.yml';

const HEADER_LINES = [
  'proxy_set_header Host',
  'proxy_set_header X-Forwarded-For',
  'proxy_set_header X-Forwarded-Host',
  'proxy_set_header X-Forwarded-Proto',
];

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

function parseWebhookRoute(constantsSrc: string): string | null {
  const m = constantsSrc.match(
    /INDEED_APPLY_WEBHOOK_ROUTE\s*=\s*'([^']+)'/,
  );
  return m ? m[1] : null;
}

function checkRepo(): Issue[] {
  const issues: Issue[] = [];
  const constantsSrc = readFileSync(R(CONSTANTS), 'utf8');
  const template = readFileSync(R(TEMPLATE), 'utf8');
  const compose = readFileSync(R(COMPOSE), 'utf8');

  const blocks = serverBlocks(template);
  const tenant = blocks.find((b) => b.tag === 'tenant');
  const admin = blocks.find((b) => b.tag === 'admin');
  const portal = blocks.find((b) => b.tag === 'portal');
  const ssl = blocks.filter((b) => ['tenant', 'admin', 'portal'].includes(b.tag));

  if (!tenant || !admin || !portal) {
    issues.push({ where: TEMPLATE, reason: 'missing one of tenant/admin/portal server blocks' });
    return issues;
  }

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
  for (const b of ssl) {
    const authLoc = locationBody(b.body, 'location /auth/');
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

function main(): void {
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`frontdoor:conf-check ok (${TEMPLATE} + ${COMPOSE} vs ${CONSTANTS})`);
    return;
  }
  console.error(`frontdoor:conf-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.where}: ${i.reason}`);
  process.exit(1);
}

main();
