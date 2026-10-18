#!/usr/bin/env node
// Local mailbox for the dev stack. With MAILER_PROVIDER=outbox (set by
// tools/local-stack.sh) every email the local services send — signer invitations,
// reminders, user invites — is written as a JSON file into MAILER_OUTBOX_DIR
// (default .local-stack/mail). Nothing is sent anywhere. This prints the latest
// messages with their links so you can open them.
//
//   node tools/local-mail.cjs        # latest 10
//   node tools/local-mail.cjs 30     # latest 30
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.MAILER_OUTBOX_DIR || path.join(ROOT, '.local-stack', 'mail');
const n = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;

if (!fs.existsSync(DIR)) {
  console.log(`[local-mail] no mail yet (${DIR})`);
  process.exit(0);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().slice(-n).reverse();
if (files.length === 0) console.log(`[local-mail] no mail yet (${DIR})`);
for (const f of files) {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const body = `${m.text || ''}\n${m.html || ''}`.replace(/&amp;/g, '&');
  const links = [...new Set(body.match(/https?:\/\/[^\s"'<>)]+/g) || [])];
  console.log(`\n${m.sent_at}  to: ${m.to}\n  subject: ${m.subject}`);
  for (const l of links) console.log(`  link: ${l}`);
}
