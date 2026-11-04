# How updates work

## What the program does by itself

Under Administration, Updates, the program asks GitHub whether a newer release exists and shows a plain message. It reads public release information only. It never downloads or runs anything.

- The default source is `https://github.com/therealwokewok/city`. A city can change it to another GitHub address, for example its own fork, or turn checking off.
- Only `https://github.com/owner/name` addresses are accepted. Anything else is refused.
- Releases are tagged `utilities-v1.2.3`. Tags that do not look like that are ignored, so other projects in the same repository do not confuse it.
- Changing the source needs the emailed safety check, and is written to the activity log.

## Why it does not install itself

A web program that downloads and runs new code from the internet gives anyone who gets into that repository, or who tricks the program into trusting a look-alike address, full control of a system that holds customer records. So installation is a decision made by the host, not by the program.

## Installing a release at the host

Each release tagged `utilities-v*` builds a container image and publishes it to `ghcr.io/<owner>/<repo>-utilities`, tagged with the version number (see `.github/workflows/utilities-release.yml` in the repository root).

Pick one:

1. **The ready-made compose file.** `docker-compose.auto-update.yml` runs the published image at the version named by `APP_VERSION` in `.env`, keeps the app on this computer only (put HTTPS in front with Caddy or nginx; `deploy/Caddyfile` is an example), and backs the database up every night. To update: read the release notes, change `APP_VERSION`, take a backup, run `docker compose -f docker-compose.auto-update.yml up -d`. The start-up script runs the database migrations first, then removes the database owner's password from the program's environment, so the running program only ever holds the limited app role. Nothing updates on its own: a program that pulls and runs new code by itself hands control of customer records to whoever controls the image.
2. **Your host's own feature.** Most container hosts can deploy a named image version. Set `RUN_MIGRATIONS_ON_START=1` and `OWNER_DATABASE_URL` as in the file above, or run `node dist/src/migrate.js` yourself as part of the deploy.
3. **By hand.** Pull the new image, run the migrations, restart.

Take a database backup before any update. A city that wants to review changes first should follow a fork and merge releases when it is ready. Migrations add tables and columns and never drop customer records (one clean-up removed orphan rows that pointed at another city's records), but a backup is still the rule.

## Going back to the previous version

Set `APP_VERSION` back to the version that worked and run the compose command again. The old image is still on the computer. If the new version's migration had already run, restore the backup taken before the update (below); the program refuses to run against a database that is newer than it is only in the sense that unknown columns are ignored, so a restore is the safe path.

## Backups and restore

The ready-made compose file writes a complete copy of the database every night into the `backups` volume and keeps 30 days. That volume lives on the same computer, so copy it somewhere else as well (a second computer, the city's file share, or an object-storage bucket with a tool such as rclone). A backup nobody has tried to restore is a hope, not a backup: restore one onto a spare computer once a quarter.

Restore, with the app stopped:

```bash
docker compose -f docker-compose.auto-update.yml stop app
docker compose -f docker-compose.auto-update.yml exec db pg_restore -U utilities_owner -d utilities --clean --if-exists /backups/utilities-YYYYMMDD-HHMM.dump
docker compose -f docker-compose.auto-update.yml start app
```

## Where the database connection lives

Two ways, and the host's choice wins:

- **From the host**: `DATABASE_URL` (and `OWNER_DATABASE_URL` for migrations), or the same names with `_FILE` pointing
  at a secret file. The Database screen then shows the connection but cannot change it; change it where the program
  is started. The compose files work this way.
- **From the setup page**: `CONFIG_DIR/database.json`, written on first start and readable by the program only
  (mode 600). It holds the app connection and the owner connection; at every start the program applies any new
  table updates as the owner before serving. A site administrator can point it at another database under
  Administration, Database: the new connection is tested first and must already hold the tables; it takes effect
  at the next restart. Keep that folder in the backups, or in a mounted volume (`/app/config` in the image).

Either way the program refuses to serve as the owner in production; the web process only ever holds the limited
`utilities_app` role.

Where the database can live: any PostgreSQL 16 or newer. The setup page has presets for Amazon RDS and Aurora
(verified with Amazon's bundle, kept as `CONFIG_DIR/aws-rds-global-bundle.pem` and refreshed every 90 days), Google
Cloud SQL (the Auth Proxy on the same server, or "verified certificate only" with the instance CA), Azure (verified
with public roots), Neon, Supabase, DigitalOcean, Heroku, Crunchy Bridge and a local server. A password is always
required and a database off this computer is always reached over TLS. Other engines (MySQL, SQL Server, SQLite) are
not supported: the row-level security, security-definer functions and triggers the program depends on are
PostgreSQL features, and the same protections cannot be rebuilt on them.

## Changing keys and passwords

- **Stripe keys or webhook secret:** edit `.env`, then `docker compose ... up -d`. The program refuses to start when only some of the three Stripe values are set, or when the webhook secret is a placeholder, so a half-done rotation is caught at once. Lost webhook secret: make a new one on Stripe's webhook page and paste it in.
- **Email token:** same.
- **Database passwords:** change `DB_OWNER_PASSWORD` in `.env` and in PostgreSQL (`alter role utilities_owner password '...'`); change `APP_DB_PASSWORD` in `.env` only, the migration step sets it in PostgreSQL on the next start.

## When the disk fills up

PostgreSQL stops accepting changes when the disk is full and the app shows "something went wrong" to everyone. Container logs are capped (10 MB each) so they cannot fill it; backups are the usual cause. Delete old `.dump` files from the `backups` volume, or give the computer more disk.
