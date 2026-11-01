# Runbook — Abuse reports and the Personal review queue

v1.0, 2026-11-01. Conventions: [README.md](README.md).
Governing text: Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.3–§6.6 and §10; Amendment
M-A7 §5.2 (R-11). Code: `libs/sign/src/lib/abuse-report.service.ts`,
`apps/sign-service/src/app/personal/sign-report.service.ts`, `libs/identity/src/lib/personal/personal-risk.service.ts`,
`apps/platform-admin/src/app/platform/platform-personal.controller.ts`.

**Staffing is a PO item.** This runbook defines what the operator on duty does; who is on duty, how often
the queues are worked and the response targets are PO decisions to record in `Aramo/documents/`.
Suggested minimum until decided: both queues checked once every working day.

## 1. Where the work arrives

| Queue | Console page (admin.aramo.ai) | API (platform session, `platform:tenant:lifecycle:manage`) |
|---|---|---|
| Abuse reports, every sender | **Abuse reports** `/sign-abuse-reports` | `GET /platform/sign-abuse-reports?outcome=OPEN` |
| Personal accounts held for review or restricted | **Review queue** `/personal-review` | `GET /platform/personal-review` |
| Reports for one Personal tenant | (from the review item) | `GET /platform/tenants/:tenant_id/personal/reports` |
| Pilot invites | **Pilot invites** `/personal-invites` | `POST /platform/personal-invites` (code shown once) |

## 2. How reports and pauses happen (facts from code)

- A recipient reports from the link in every signing request and reminder email (`POST /v1/sign/report`,
  public, with their signing token) or from their inbox (`POST /v1/sign/inbox/:id/report`). One report per
  recipient per envelope. Reasons: `phishing, impersonation, spam, unknown_sender, other` (+ optional
  note ≤ 1000 chars). The reporter's address is stored only as a one-way digest.
- Each report carries `weight = severity × independence × credibility`; credibility halves for each earlier
  report by the same reporter judged `FALSE_REPORT`.
- **Personal sender:** when the weighted total in the window reaches the threshold (defaults: 4 within 30
  days, `DEFAULT_ABUSE_REPORT_CONFIG`), the account is **automatically restricted for 72 h**: new sends
  pause, existing envelopes and guest signing are untouched, and the account enters the review queue. The
  pause **lapses by itself** unless an operator confirms it.
- **Business sender:** reports are recorded and queued for operators; never an automatic pause.
- Personal risk states: `clear | review | restricted | closed`. `restricted` with `restricted_until` in the
  future = temporary automatic pause; `restricted_until` empty = operator-confirmed restriction.
- New Personal signups may also land in `review` (signup checks; while SMS is unavailable, "review
  replaces phone", PO 2026-10-21). Clearing review never sets phone assurance.

## 3. Abuse report procedure

For each `OPEN` report (newest first):

1. Read the sender (kind + name), reason, note, weight and whether it triggered a restriction. Do **not**
   open the envelope's documents; the report is about the email.
2. Look at the sender's other reports (`GET /platform/tenants/:tenant_id/personal/reports` for Personal).
3. Decide (`POST /platform/personal-reports/:report_id/decide` `{outcome, reason}`; console button):

   | Outcome | When |
   |---|---|
   | `CONFIRMED` | The email is abusive (phishing, impersonation, unsolicited bulk). |
   | `FALSE_REPORT` | The report is wrong (e.g. the recipient knows the sender). Lowers that reporter's credibility for future reports. |
   | `DISMISSED` | Not enough to judge, or not abuse but not false either. |

   Deciding a report records the outcome only; it does **not** change the account. Account actions are §4.
4. Business sender with `CONFIRMED` reports: notify the PO with the tenant id and report ids; contacting or
   suspending a Business organisation is a PO decision (no automatic action exists).
5. Phishing that impersonates Aramo or a known brand: also notify the PO immediately (possible takedown and
   mail-reputation impact on the SES sender).

## 4. Personal review queue procedure

Each item shows the account's stored signals and `review_clears_phone_step`. Actions (each needs a written
reason and is audited in the same transaction; console buttons or
`POST /platform/tenants/:tenant_id/personal/{clear-review|restrict|reinstate|close}` `{reason, until?}`):

| Situation | Action |
|---|---|
| New signup in `review`, signals unremarkable | **Clear review** (approve). If `review_clears_phone_step` is true, this also lifts the outstanding phone step. |
| Temporary automatic pause after reports; reports look `CONFIRMED` | **Restrict** with no `until` (operator-confirmed restriction) — or with an `until` for a bounded pause. Decide the reports too (§3). |
| Temporary pause; reports look false | Decide the reports `FALSE_REPORT`/`DISMISSED`, then **Reinstate** (or let the pause lapse). |
| Clear, serious abuse (phishing) | **Close** the account (sends stop; existing envelopes remain for their recipients). Notify the PO. |
| Previously restricted, appeal accepted | **Reinstate**. |

A closed account cannot be restricted again (409 `illegal_risk_transition`). `until` must be in the future.

## 5. Record keeping

Weekly (or as the PO sets): counts of reports by outcome and of review actions, read-only:

```bash
PGRO <<'SQL'
SELECT outcome, count(*) FROM sign."AbuseReport" WHERE created_at > now() - interval '7 days' GROUP BY 1;
SELECT count(*) FILTER (WHERE outcome = 'OPEN' AND created_at < now() - interval '2 days') AS open_older_than_2_days
  FROM sign."AbuseReport";
SQL
```

Never export reporter digests, notes or sender names outside the console.
