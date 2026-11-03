# Security

utilities handles people's names, addresses and billing. It is built so that city staff and residents can
only do and see what their role allows, and so that card and bank details never reach the server.

## Reporting a problem

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository
(Security tab). Do not open a public issue for a security problem. We aim to answer within 7 days.

## What the design guarantees

| Area | Rule | Where it is enforced | Test |
|---|---|---|---|
| Payment data | Card and bank details are typed into Stripe's Payment Element, which runs in Stripe's own frames inside the pay page. The server never sees or stores them. Stripe.js is loaded only from js.stripe.com and only on pages that take a payment; the Content-Security-Policy allows no other outside scripts, which is what PCI DSS 4.0 (6.4.3 and 11.6.1) asks of a page that hosts payment fields. Each city should confirm its PCI questionnaire with its processor. | `src/adapters/payments.ts`, `public/assets/js/stripe.js`, CSP in `src/server.ts` | `stripe.test.ts`, `api.test.ts` payments |
| Tenant isolation | Every table has `city_id` and row-level security. The app role cannot bypass it. | `001_init.sql` | `security-db.test.ts` |
| Roles | Permissions come from roles. A person can hold several; permissions add up. Each route checks one, and the database checks it again. | `permissions.ts`, RLS, `004_guards.sql` | `api.test.ts`, `security-db.test.ts` |
| Money history | The ledger only gets new rows. Corrections are reversals. Updates and deletes are blocked for the app and by trigger for everyone. | `ledger_no_edit` | `security-db.test.ts` |
| Separation of duties | Whoever starts a bill run cannot approve it. Whoever submits a reading cannot review it. Whoever requests an adjustment or a refund cannot approve it. A refund can never exceed the customer's credit. Large adjustments need two different approvers. | domain code plus CHECK constraints | `billing.test.ts`, `refund.test.ts` |
| Sign-in | No passwords exist. A one-time 8-digit code is emailed, stored only as a hash, good for 10 minutes and 5 tries. At most 3 codes per email in 10 minutes, and asking again past that sends nothing, so nobody can flood an inbox or learn who has an account. | `auth.ts` | `api.test.ts`, `e2e/resident.spec.ts` |
| Step-up | Approving runs and bill changes, changing rates, settings and roles, turning services on or off, turning off a person, and issuing link codes need a fresh email code. | `auth.ts`, `permissions.ts` | `api.test.ts`, `e2e/admin.spec.ts` |
| Audit trail | Hash-chained, append-only for the app, readable and checkable on the Activity log screen (administrators and auditors). | `audit_append`, `audit_verify` | `security-db.test.ts` |
| Service requests | A resident can only ask about an account linked to them, and only as themselves. Residents see only their own requests. Only billing clerks, customer service and city administrators can work the queue, and only status and the note can change. A request cannot touch a bill, balance or ledger. | `006_service_requests.sql`, `domain/accounts.ts` | `api.test.ts`, `security-db.test.ts`, `e2e/requests.spec.ts` |
| Resident linking | Account number plus the code printed on the bill. Five misses in an hour locks linking. Same error whether or not the account exists. | `link_account()` | `api.test.ts` |
| Sessions | Random token, only its hash is stored, new token at each sign-in, idle and absolute timeouts, CSRF token on every change, origin check, `HttpOnly` and `Secure` cookies. | `auth.ts`, `server.ts` | `api.test.ts` |
| Passkeys | Optional sign-in with a fingerprint, face or device PIN (WebAuthn). Only the public key is stored. User verification is required, challenges are one-time and expire in 5 minutes, and the emailed code always still works. | `012_passkeys.sql`, `src/passkeys.ts` | `passkeys.spec.ts` (real Chrome, virtual authenticator) |
| Single sign-on | Optional OpenID Connect, off unless configured. Authorization code with PKCE, state and nonce checked, issuer and audience checked, verified email required. It only signs in people who already have an account; it never creates one. | `src/adapters/sso.ts` | `sso.test.ts` |
| Autopay | Only the processor's opaque customer and method ids and a label like "Visa card ending 4242" are stored. One charge attempt per bill, ever. The amount is never more than the bill or the balance. Only signed webhooks confirm money. | `011_autopay.sql`, `src/domain/autopay.ts` | `autopay.test.ts` |
| Work orders | The office orders a shutoff only for an account past its notice period. Only field staff can mark an order done, the database enforces it, and they see the address and note, never names or balances. | `009_*.sql` | `workorders.test.ts` |
| Emailed bills | One email per bill, never with a card number, only to people linked to the account. Staff cannot read the addresses. | `009_*.sql` | `workorders.test.ts` |
| Logo and color | PNG or JPEG only (checked by file signature), under 300 KB, served with `nosniff`. Colors must keep white text readable. Changing either needs the email safety check. | `src/server.ts`, `src/settings.ts` | `api.test.ts` |
| Update check | Reads public release information from api.github.com for an address that must be a `github.com/owner/name` link. It never downloads or runs code. | `src/updates.ts` | `updates.test.ts` |
| Webhooks | Signature and age checked on the raw body, event ids stored so repeats do nothing, amount must match. | `domain/payments.ts` | `api.test.ts` |

## Before you go live (the handoff gate)

1. Use your own database, your own Stripe account (owned by the city only), your own email sender.
2. Set strong values in `.env`; run migrations as the owner, run the app as `utilities_app`.
3. Serve only over HTTPS. Turn on database backups with point-in-time recovery and test a restore.
4. Remove the builder's and any test accounts. Make sure at least two people hold the city admin role.
5. Set the real rates, penalty rules and approval limit under Settings, and print a test page on your real paper.
6. Run the sign-in, link, bill, approve, pay, and refund path once end to end with Stripe in test mode.

## Known gaps in this version

- Everyone can sign in with an emailed code. Passkeys and OpenID Connect single sign-on are optional. Changing a risky setting still asks for an emailed code, even after a passkey or single sign-on.
- Anyone who can read a person's email can sign in as them, so staff email accounts should have their own two-step sign-in turned on.
- The screens are tested in Chrome only so far, with automated accessibility scans. Firefox, Safari, Edge and a real screen reader still need a pass (see the README).
- Autopay (see docs/autopay.md for scheduling) talks to Stripe's off-session payment API. It is covered by tests against a fake processor and by checking the request shapes, but it has not been run against a live Stripe account. Try it with a Stripe test key first.
- Single sign-on has been tested against a fake provider only. Try it with your own provider before relying on it.
- Refunds are recorded here after a second person approves. The money is paid back by the city outside this program.
- No independent security review has been done. Have someone you trust read `001_init.sql`, `004_guards.sql` and `server.ts`.
- Demo mode (`demo_mode` setting) blocks real payment processors in `src/settings.ts` `assertMoneyAllowed`, covered by `demo.test.ts`. It is a guard against mistakes, not a security boundary: the person who can turn it off is a settings administrator, and the change is written to the activity log.
