# Security review, November 2026

Three independent reviews of the whole codebase: one on who may do what, one on the application (injection, scripts in
the browser, sessions, money math, webhooks), and one on deployment and the supply chain. Every finding below was proven
with a test that failed, then fixed, and the test now passes and stays in the suite (`test/authz-audit*.test.ts`,
`test/appsec-audit.test.ts`). Nothing listed as fixed is taken on faith.

## Fixed

**Roles and approvals**
- A site administrator could remove the only city administrator and then appoint their own. Now only a city
  administrator can add, remove or turn off a city administrator, the last one can never be removed, and every role
  change is emailed to the other administrators.
- Approving a payment plan did not ask for the emailed safety code. It does now, and a plan's first payment must be
  due within 3 months.
- A site administrator could change money settings (approval limit, late charge, fees). Money settings are now
  city-administrator only, and the safety-check window is 1 to 30 minutes.
- Late charges could be added for a date that had not come yet.
- Small credits could be split to stay under the approval limit. Credits a person adds to one account now add up.
- Meters, services and roles could be attached to another city's records. The app and the database both refuse.

**Money**
- A payment could be charged twice from two tabs or a double click, and the second try then blocked the first from
  being credited. One charge per payment now; a successful charge is recorded at once.
- A declined card marked the payment failed, so a successful retry was never credited.
- Autopay could collect more than the balance when two bills were due and a payment was still on its way.
- Fixing a meter reading in a bill run that was not approved yet credited the customer twice.
- A fractional rate value or "days until due" could make every bill run fail. Whole numbers are required.

**Residents and the database**
- The database itself now refuses what the app never offered: a resident marking a payment paid, pointing autopay at
  another card, reopening a declined plan, editing account details, or changing their own email.
- One open question per bill and at most three open leak reports, so the staff queue cannot be flooded.
- Payment starts and autopay set-ups are limited per person per hour.

**Deployment**
- The pretend payment processor used by demos accepted events signed with a public constant. It now uses a random
  secret, and the app refuses to start with a half-finished Stripe setup.
- In production the app refuses to run as the database owner (which would switch off row security).
- Per-address sign-in limits trusted whatever address the client claimed. `TRUST_PROXY=1` now means exactly one
  proxy in front.
- The ready-made compose file ran a floating `latest` image through an unverified auto-updater with root access to
  Docker, published the app to the whole network, and took no backups. It now runs a named release, listens on the
  computer only, caps log sizes, and takes a nightly database backup kept for 30 days. Restore, rollback and key
  rotation are documented in `docs/updates.md`.
- The demo mail relay checked only the caller's address. It now also needs a secret token and allows 60 messages a
  minute. Addresses are stripped of line breaks before going into a subject.
- Errors are now logged (warnings and above, never request bodies), `/healthz` works without a host name, the host
  cache cannot grow without bound, a `.dockerignore` keeps secrets and tests out of images, and demo logs that held
  link codes are no longer world-readable.
- A long address could push a bill onto an extra page and misalign every envelope after it.

## Known limits, by design

- The demo server pulls the newest code from GitHub on every restart. Whoever can push to the repository controls
  the demo. A real installation runs a named release (`APP_VERSION`) and never auto-updates.
- One person holding two staff logins can be both requester and approver. The emails to other administrators on
  every role change are the check on that; a city with one administrator should add a second.
- The demo sends every sign-in code to one inbox, so that inbox is the demo's master key. Never put real customer
  data on a demo.
- Backups land on the same computer. Copy them elsewhere, and practise a restore.

## Confirmed sound

Parameterized SQL throughout; no HTML built from data in the browser (text nodes only) and a strict content security
policy; `__Host-` secure cookies, CSRF token plus origin check, sessions revoked on sign-out and deactivation, roles
re-read on every request; 8-digit one-time codes with per-email, per-address and per-code limits; passkeys and
single sign-on with one-shot challenges bound to the city; signed and replay-proof webhooks with the raw body; an
append-only ledger and a chained, verifiable activity log; integer cents everywhere; no secrets or stack traces in
responses or logs; no vulnerable dependencies (`npm audit` clean, lockfile pinned, no install scripts in production
dependencies).

## Screen quality standard

Every screen is also measured, on a desktop browser and a phone, against a written standard (`e2e/layout-audit.ts`,
run by `npm run audit:ui` and in CI): WCAG 2.2 AA (axe-core) and reflow at 320px wide; 44px touch targets; a 4px
spacing grid; at least 12px between a box's edge and what is inside it; no overlapping, clipped or cut-off content;
lines of at most 80 characters; body text at least 16px and small print at least 14px; one h1 and no skipped heading
levels. The November 2026 pass found and fixed: list cards with no inner padding (service requests, field orders),
form fields and badges off the spacing grid, a cramped button on the staff home grid, and a phone menu that clipped
"Administration".
