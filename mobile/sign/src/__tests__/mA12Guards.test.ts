// M-A12 guards (§4 item 8):
//   - no AI, cloud-storage or email-in control renders (D-4 HOLD, Wave 3 not built);
//   - no Stripe or external purchase URL is reachable in the app: purchases go through
//     the platform store only (D-3; M-A7 :25 as amended).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FEATURES } from '../config/features';
import { WEB_LINKS } from '../config/env';
import { addSourceTiles } from '../features/send/AddDocumentsSheet';
import { createStoreBillingApi } from '../features/plans/purchaseFlow';
import { workspaceWith } from '../features/inbox/__tests__/fixtures';

jest.mock('../features/send/sources', () => ({ scanToPdf: jest.fn(), pickPdf: jest.fn() }));
jest.mock('../features/send/photos', () => ({ pickPhotosToPdf: jest.fn() }));

const SRC = join(__dirname, '..');

function appFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(SRC, p);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'testing' || rel === join('api', 'generated')) continue;
      out.push(...appFiles(p));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The file without comments, so only code and copy are checked. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FILES = appFiles();

describe('M-A12: hidden controls stay hidden', () => {
  it('the AI, cloud, email-in, offline and sounds switches are off', () => {
    expect(FEATURES).toMatchObject({
      aiControls: false,
      cloudImports: false,
      emailIn: false,
      offlineSigning: false,
      sounds: false,
    });
  });

  it('the document sources are Scan, Photos, Templates and Files only', () => {
    expect(addSourceTiles(true).map((t) => t.key)).toEqual(['scan', 'photos', 'templates', 'files']);
  });

  it('no AI, cloud-storage or email-in control label exists in the app', () => {
    const banned = /(['"`>])\s*(AI summary|Summarize|Suggest fields|AI assist[^'"`<]*|Google Drive|OneDrive|Dropbox|Box|Connect storage|Cloud storage|Email-in|Forward a document[^'"`<]*|sign@aramo\.ai)\s*(['"`<])/;
    const hits = FILES.filter((f) => banned.test(code(f))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});

describe('M-A12: no Stripe or external purchase URL', () => {
  it('no app file reaches Stripe, a checkout or a web pricing / upgrade page', () => {
    const banned = /stripe\.(com|js)|@stripe\/|buy\.stripe|\/billing\/checkout|\/checkout|checkout\.|\/pricing|\/upgrade|paypal/i;
    const hits = FILES.filter((f) => banned.test(code(f))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('no Stripe SDK in the app', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((d) => /stripe/i.test(d))).toEqual([]);
  });

  it('the web links the app opens are help and legal pages only', () => {
    for (const url of Object.values(WEB_LINKS)) expect(url).toMatch(/\/(help|legal\/[a-z-]+)$/);
  });

  it('the store billing client calls only /billing/plans and /billing/store/*', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: { plans: [], intent_id: 'i', app_account_token: 't' } }));
    const api = createStoreBillingApi(workspace);
    await api.plans();
    await api.intent({ platform: 'ios', product_id: 'p' });
    await api.verify({ platform: 'ios', product_id: 'p', intent_id: 'i', signed_transaction: 'jws' });
    await api.restore({ platform: 'ios', signed_transactions: ['jws'] });
    expect(net.calls.map((c) => c.url.replace('https://sign.aramo.ai', ''))).toEqual([
      '/v1/sign/billing/plans',
      '/v1/sign/billing/store/intent',
      '/v1/sign/billing/store/verify',
      '/v1/sign/billing/store/restore',
    ]);
  });
});
