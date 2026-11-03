# Hosting a demo

This sets up a public demo on one small Ubuntu server: the app, PostgreSQL and Caddy (which gets and renews the HTTPS certificate by itself). The city is in demo mode, so it cannot move real money. Payments use the pretend processor unless Stripe TEST keys are put in `.env`; sign-in codes go to the mail relay below, or to the app log without it.

1. Point a DNS record (not proxied) for your demo host name at the server.
2. Create an Ubuntu 24.04 server with `cloud-init-demo.yaml` as its user data, after editing the host name and admin email in it.
3. After a few minutes, browse to the host name and sign in as the admin email.

The server pulls the newest code from GitHub every time it restarts, keeping its database. That is right for a demo whose point is to show the latest work; it means whoever can push to that repository controls the demo server, so keep two-factor sign-in on the GitHub account and never put real customer data on a demo. A real installation runs a named release instead (see docs/updates.md). The install log is `/var/log/install-demo.log`.

Email: without an email service, sign-in codes are only written to the app log. `mail-relay/worker.js` is a free Cloudflare Worker that sends every message to one verified inbox, with the intended address in the subject. Set `EMAIL_API_URL` and `EMAIL_FROM` in the settings block of `cloud-init-demo.yaml`. The script makes an `EMAIL_API_TOKEN` the first time; copy it from `.env` on the server into the Worker as a secret named `MAIL_TOKEN` (Worker settings, Variables and secrets). The Worker then accepts calls only from the server's IP that also carry that token, and no more than 60 a minute.

Test people: `node dist/scripts/test-users.js <host> <domain>` adds two people for every role, such as `billing_clerk_1@<domain>`. The script runs once per server (a marker file stops it running again, so roles an administrator removes stay removed).

A real installation uses a managed PostgreSQL with backups, a real email service and the city's own Stripe account. See the main README.
