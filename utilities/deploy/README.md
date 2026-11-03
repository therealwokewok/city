# Hosting a demo

This sets up a public demo on one small Ubuntu server: the app, PostgreSQL and Caddy (which gets and renews the HTTPS certificate by itself). It uses the fake payment processor and writes sign-in codes to the log instead of emailing them, and the city is in demo mode, so it cannot move real money.

1. Point a DNS record (not proxied) for your demo host name at the server.
2. Create an Ubuntu 24.04 server with `cloud-init-demo.yaml` as its user data, after editing the host name and admin email in it.
3. After a few minutes, browse to the host name and sign in as the admin email.

The server updates itself from GitHub every time it restarts, keeping its database. Its log is `/var/log/install-demo.log`.

Email: without an email service, sign-in codes are only written to the app log. `mail-relay/worker.js` is a free Cloudflare Worker that sends every message to one verified inbox, with the intended address in the subject. Set `EMAIL_API_URL`, `EMAIL_API_TOKEN` and `EMAIL_FROM` in the settings block of `cloud-init-demo.yaml`.

Test people: `node dist/scripts/test-users.js <host> <domain>` adds two people for every role, such as `billing_clerk_1@<domain>`.

A real installation uses a managed PostgreSQL with backups, a real email service and the city's own Stripe account. See the main README.
