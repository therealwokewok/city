# utilities

Free, open-source utility billing for small cities. Meter readers submit reads from a phone, staff review and
bill them, residents look up bills and pay online. Water, sewer, trash, electric (including several meters on
one account), security lights, and any extra charge a city invents. Card and bank details never touch your server.

Built first for the City of Osceola, Missouri, but nothing about Osceola is hard-coded: rates, penalty rules,
paper sizes, envelope layouts, office hours and approval limits are all settings.

**Status: early.** The server, database, security model and web screens for residents, meter readers, billing staff and administrators are built. They are tested in Chrome on a phone-size and a desktop-size window. They have not yet been run in Firefox, Safari or Edge, or with a real screen reader (see Browser support below).
See [SECURITY.md](SECURITY.md) for what is and is not covered.

## What works today

| Area | Done |
|---|---|
| Sign-in | No passwords for anyone. A one-time 8-digit code is emailed (good for 10 minutes, 5 tries, at most 3 codes per email per 10 minutes). Optional passkeys, and optional single sign-on with any OpenID Connect provider |
| People and roles | 9 roles, several per person, step-up email codes for risky actions |
| Meter reads | Offline-friendly batch upload, duplicate-safe, flagged reads, second-person review |
| Billing | Rates with effective dates and tiers, per-meter electric, sewer on water use, natural gas and propane (with unit conversion and a named supply adjustment), several of the same flat service on one account (two security lights), tax, extra charges on demand, bill runs approved by a second person |
| Money | Append-only ledger, 10% (configurable) late charge rounded up, shutoff list with notice period, adjustments and refunds with one or two approvers, reversals. Each bill shows Paid, Partly paid (with what is left) or Not paid |
| Payment plans | A resident asks online, or staff enter one for a caller; an approver approves (and can change the number of payments or the start date) or declines with a note; the resident is emailed. While the customer keeps up, the bills in the plan get no late charge and the plan amount does not count toward shutoff. See [docs/payment-plans.md](docs/payment-plans.md) |
| Meter read fixes | A clerk picks a wrong reading and types the right number. The app reprices every bill that used it, with the rate that applied then, and sends the difference for approval. Once approved, the reading and the next reading's usage are fixed together and the customer sees "Corrected meter reading" on their account |
| Payments | Stripe Payment Element inside the pay page (card and ACH bank account; nobody leaves the site), with signed, repeat-safe webhooks; cash and check at the counter. Autopay with a card or bank account saved the same way. Optional online payment fee shown as its own line before paying (credit cards only, all cards, and/or bank payments; see [docs/payment-fees.md](docs/payment-fees.md)). Needs `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; a demo may use Stripe test keys |
| Residents | Sign in, link an account with the code printed on the bill, view bills, pay all or part, ask for a payment plan, set up autopay, dispute, go paperless (bills arrive by email) |
| Shutoffs | Staff order a shutoff only after the notice period; the field crew sees the address and marks it done; reconnect orders only after the account is paid up |
| Service requests | New service, disconnect, move out (with a forwarding address for the final bill), move to a new address, report a leak. Residents see the status and any note from City Hall. Staff work one queue; declining needs a reason. A request never changes a bill or balance by itself |
| Printing | Bills and envelopes as PDFs from print profiles you define for any paper or envelope size, with a test page |
| Screens | Phone-first and large-print friendly: text size buttons, big tap targets, plain wording, works offline for meter readers. Residents, meter readers, billing staff, cashiers, approvers, auditors, administrators |
| Administration | Staff and roles, city settings, services on or off, rates by start date, print layouts, the city's color and logo, update source, and a readable activity log with a tamper check |
| Safety | Row-level security, audit chain, host-based city lookup, CSRF, security headers |

Services a city can turn on: water, sewer, electric, trash, security light, natural gas, propane, stormwater, recycling, yard waste, ambulance subscription, internet, irrigation and street light. Only the ones a city switches on appear in bills and forms. Staff can change services, quantities and meters on any account from its page. Refunds of a credit go through a second-person approval (the city pays the money back by check or its own bank; utilities never moves money out). Starting values for a state live in `packs/` (Missouri is included; add yours). Autopay can be collected by a staff button or on a schedule (see [docs/autopay.md](docs/autopay.md)). Not built yet: a screen for editing a rate's history.

## Try it

```bash
docker compose up --build         # database, migrations, app on http://localhost:8080
docker compose exec -e OWNER_DATABASE_URL=postgres://utilities_owner:dev@db:5432/utilities app node dist/scripts/seed.js   # optional demo city
```

Without Docker: Node 22 and PostgreSQL 16, then `npm ci`, `npm run migrate`, `npm run seed`, `npm run dev`.
In development, sign-in codes print to the console and payments use a fake processor.

## Install for a real city

1. Start the program (the container, or `node dist/src/main.js`) with no `DATABASE_URL`. It prints a setup code and
   serves a **setup page** at `/setup`. There you type the database owner's connection (one address, separate
   fields, or a local socket, with TLS off, required or verified), press Test, and the program creates the tables
   and a limited `utilities_app` role for itself. Then the city: name, state, time zone, web address, office name,
   phone, hours, addresses, and the first administrator. The real site starts on the same port when you finish.
   The page knows the common hosts and picks the right verification for each: Amazon RDS and Aurora (Amazon's
   certificate bundle is fetched for you), Google Cloud SQL (through the Auth Proxy, or with the instance CA),
   Azure Database for PostgreSQL, Neon, Supabase, DigitalOcean, Heroku, Crunchy Bridge, or PostgreSQL on the same
   computer. Two rules are never optional: every connection has a password, and any database that is not on this
   computer is reached over TLS. The engine is PostgreSQL 16 or newer only: the wall between customers (row-level
   security), the approvals and the tamper-evident ledger live inside it, and no other engine offers the same.
   Prefer settings from the host instead? Set `DATABASE_URL` (or `DATABASE_URL_FILE`) and the setup page only
   asks about the city. The ready-made `docker-compose.auto-update.yml` does that and bundles PostgreSQL.
2. Put it behind HTTPS on its own subdomain (the app listens on this computer only; `deploy/Caddyfile` is an example proxy). Fill in `.env` (see `.env.example`). The compose file backs the database up every night; copy the backups off the computer.
3. Work through the handoff gate in [SECURITY.md](SECURITY.md).
4. The city creates **its own** Stripe account and keeps the keys. No platform fee is added by this software.

Afterwards, a site administrator changes the database connection under Administration, Database (checked first,
applied at restart), and a city or site administrator changes the name, state, time zone and web addresses under
Administration, The city. Everything a resident reads, from the name of the office ("City Hall", "Village Hall")
to the smallest online payment and the longest payment plan, is a setting. `npm run bootstrap` still works for
scripted installs.

## How it is put together

TypeScript on Node 22, Fastify, PostgreSQL 16. One container image, one database. Email, payments and single sign-on
are adapters in `src/adapters/`, so no vendor is required. Rates are data in the database.
Everything in `src/domain/` takes a database transaction and the signed-in person, so the same rules apply
whether the call comes from the web, a script, or a test.

```
src/migrations/   database schema, row-level security, guards
src/domain/       accounts, billing, payments rules
src/server.ts     HTTP API (every route names the permission it needs)
src/printing.ts   bill, envelope and test-page PDFs
public/           the web screens: plain JavaScript, no framework, no build step
e2e/              browser tests (Playwright) with accessibility scans
test/             unit and HTTP tests, including role, tenant and security boundaries
packs/            starting values per state (a pack never sets rates)
docs/             how updates work
```

## Updates

Administration, Updates shows whether a newer version exists and lets the city choose which GitHub address it checks (a fork, say). Installing the update is up to whoever hosts the program, because a running program should never replace its own code: name the release in `.env` and restart. The ready-made compose file also takes a nightly database backup. See [docs/updates.md](docs/updates.md).

## Sign-in options

Passkeys need nothing extra; people add one under "My sign-in options". Single sign-on is off until you set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` (see `.env.example`). It only signs in people who already have an account.

## License

Apache License 2.0. See [LICENSE](LICENSE). Free for any city to use, change and share.

## Browser tests

```
npx playwright test --project=chrome-phone
npx playwright test --project=chrome-desktop
```

Run each project on its own, because they share one throwaway database (`utilities_e2e`, rebuilt every run, so
point `E2E_ADMIN_URL` at a database owner account first). Every test also runs an accessibility scan (axe,
WCAG 2.0 to 2.2 A and AA rules) and checks that no page scrolls sideways.

The test server in `e2e/server.ts` has test-only routes that read sign-in codes and fake a payment. It is
never part of the production image.

## Browser support

| Browser | Status |
|---|---|
| Chrome, phone-size window | Tested on every change |
| Chrome, desktop window | Tested on every change |
| Edge | Same engine as Chrome. Not run separately yet |
| Firefox | Config is ready, not run yet |
| Safari (WebKit) and iPhone | Config is ready, not run yet |

To run the rest on your own computer:

```
npx playwright install firefox webkit msedge
ALL_BROWSERS=1 npx playwright test --project=firefox-desktop
ALL_BROWSERS=1 npx playwright test --project=safari-desktop
ALL_BROWSERS=1 npx playwright test --project=iphone
ALL_BROWSERS=1 npx playwright test --project=edge-desktop
```

Automated scans do not catch everything. Before launch, try the screens with a screen reader (NVDA on
Windows, VoiceOver on iPhone) and on a real phone.

## Demo mode

A new city made with the bootstrap script starts in demo mode, so a pilot can never be mistaken for the real system. While it is on:

- every page shows a yellow bar saying this is a demo, and a faint DEMO sits behind the pages (hidden from screen readers);
- search engines are told to stay away (`X-Robots-Tag` header and `robots.txt`);
- real payment processors are refused, including autopay runs. The built-in fake processor still works for trying things out.

Turn it off under Administration, Colors, logo and demo mode, or start a city already official with `npm run bootstrap -- ... --official`. Cities created before this setting existed are not in demo mode.
