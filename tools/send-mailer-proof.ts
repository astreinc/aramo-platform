// Email-S1 real-send PROOF harness (ops one-off — NOT app code).
//
// S1 shipped @aramo/mailer as a capability lib only: the mailer is NOT wired
// into AppModule or any HTTP route (route wiring is S2's job), so there is no
// endpoint to trigger a send. This standalone script exercises the REAL
// SesMailerAdapter once, to prove the mailer→SES pipe end-to-end: an email
// actually leaves Aramo and lands in a real inbox. It is NOT imported by any
// module, is NOT a route, and changes ZERO runtime app behaviour.
//
// It constructs the SAME objects the prod DI binding constructs — loadMailerConfig
// (the MAILER_PROVIDER=ses path) + SesMailerClientFactory + SesMailerAdapter —
// and calls .send() directly. No stub. If MAILER_PROVIDER is not `ses`, it
// refuses (we want the real adapter, not the log-only stub).
//
// ── Requires the PROD SES env (the same vars the api container reads) ────────
//   MAILER_PROVIDER=ses
//   SES_FROM_ADDRESS="Aramo Support <support@aramo.ai>"
//   AWS_REGION=us-east-1
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   (a principal with ses:SendEmail
//                                                granted on the aramo.ai identity,
//                                                pinned to support@aramo.ai)
// SES must be out of sandbox to send to an arbitrary recipient.
//
// ── How to run it ON THE BOX ─────────────────────────────────────────────────
// The api CONTAINER cannot run this as-is: `nx build api` only builds api's
// dependency graph, and api does NOT import @aramo/mailer, so dist/libs/mailer
// (and thus node_modules/@aramo/mailer) is absent from the image; the image
// also ships no source tree. So run it from the REPO CHECKOUT on the box, where
// the same .env that feeds compose is sourced into the shell (identical SES env
// + AWS creds — the ses:SendEmail grant is on the AWS_ACCESS_KEY_ID principal,
// not the container, so a host process authenticates identically):
//
//   cd <repo-on-box>
//   set -a && source .env && set +a            # SES env + AWS creds → shell
//   npx nx build mailer                        # produce dist/libs/mailer (+ common)
//   bash tools/local-run-link.sh               # symlink node_modules/@aramo/* → dist/libs/*
//   node --import jiti/register tools/send-mailer-proof.ts purush@astreinc.com
//
// Mechanism: jiti transpiles THIS .ts entry on the fly (no precompile), while
// its @aramo/* imports resolve through the node_modules/@aramo/* symlinks to the
// COMPILED dist/libs/* — i.e. the real built SesMailerAdapter. So: entry = jiti
// (TypeScript directly), libs = dist (compiled). `nx build mailer` is required.

import { createAramoLogger } from '@aramo/common';
import { loadMailerConfig, SesMailerAdapter, SesMailerClientFactory } from '@aramo/mailer';

// Default recipient = the inbox the proof targets; override via argv[2].
const RECIPIENT_FALLBACK = 'purush@astreinc.com';

async function main(): Promise<void> {
  const to = process.argv[2] ?? RECIPIENT_FALLBACK;

  // The same config load the prod binding uses. Fails LOUD if MAILER_PROVIDER
  // is unset/invalid or ses-without-SES_FROM_ADDRESS.
  const config = loadMailerConfig();
  if (config.provider !== 'ses') {
    throw new Error(
      `Refusing to run the real-send proof with MAILER_PROVIDER=${config.provider}. ` +
        'Set MAILER_PROVIDER=ses (+ SES_FROM_ADDRESS) so the REAL SesMailerAdapter is exercised.',
    );
  }

  const adapter = new SesMailerAdapter(
    new SesMailerClientFactory(),
    createAramoLogger('send-mailer-proof'),
  );

  console.log(
    `[send-mailer-proof] sending via SES — from=${JSON.stringify(config.fromAddress)} ` +
      `region=${config.region} to=${JSON.stringify(to)} ...`,
  );

  const { message_id } = await adapter.send({
    to,
    subject: 'Aramo S1 mailer proof',
    html: '<p>S1 SES mailer real-send proof. If you received this, S1 is complete.</p>',
    text: 'S1 SES mailer real-send proof. If you received this, S1 is complete.',
  });

  console.log(`[send-mailer-proof] OK — SES MessageId: ${message_id}`);
  console.log('[send-mailer-proof] S1 real-send proof SENT. Check the inbox.');
}

main().catch((err: unknown) => {
  console.error('[send-mailer-proof] FAILED — the real send did not go through:');
  console.error(err);
  // A SES AccessDenied here almost always means the From-address does not match
  // the IAM ses:FromAddress condition (support@aramo.ai), or the principal
  // lacks ses:SendEmail on the aramo.ai identity.
  process.exit(1);
});
