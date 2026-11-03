# Hosting a demo

This sets up a public demo on one small Ubuntu server: the app, PostgreSQL and Caddy (which gets and renews the HTTPS certificate by itself). It uses the fake payment processor and writes sign-in codes to the log instead of emailing them, and the city is in demo mode, so it cannot move real money.

1. Point a DNS record (not proxied) for your demo host name at the server.
2. Create an Ubuntu 24.04 server with `cloud-init-demo.yaml` as its user data, after editing the host name and admin email in it.
3. After a few minutes, browse to the host name and sign in as the admin email. Read the code with:
   `docker compose -f docker-compose.demo.yml logs app | grep -i code`

A real installation uses a managed PostgreSQL with backups, a real email service and the city's own Stripe account. See the main README.
