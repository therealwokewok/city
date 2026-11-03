# How updates work

## What the program does by itself

Under Administration, Updates, the program asks GitHub whether a newer release exists and shows a plain message. It reads public release information only. It never downloads or runs anything.

- The default source is `https://github.com/therealwokewok/city`. A city can change it to another GitHub address, for example its own fork, or turn checking off.
- Only `https://github.com/owner/name` addresses are accepted. Anything else is refused.
- Releases are tagged `utilities-v1.2.3`. Tags that do not look like that are ignored, so other projects in the same repository do not confuse it.
- Changing the source needs the emailed safety check, and is written to the activity log.

## Why it does not install itself

A web program that downloads and runs new code from the internet gives anyone who gets into that repository, or who tricks the program into trusting a look-alike address, full control of a system that holds customer records. So installation is a decision made by the host, not by the program.

## Making it automatic at the host

Each release tagged `utilities-v*` builds a container image and publishes it to `ghcr.io/<owner>/<repo>-utilities` with the tags `latest` and the version number (see `.github/workflows/utilities-release.yml` in the repository root).

Pick one:

1. **Watchtower, ready made.** Use `docker-compose.auto-update.yml` instead of the trial `docker-compose.yml`. It runs the published image, checks once a day, and when it restarts the app on a new version the start-up script runs the database migrations first. Before the web server starts, the script removes the database owner's password from the program's environment, so the running program only ever holds the limited app role.
2. **Your host's own feature.** Most container hosts can watch an image tag and redeploy. Set `RUN_MIGRATIONS_ON_START=1` and `OWNER_DATABASE_URL` as in the file above, or run `node dist/src/migrate.js` yourself as part of the deploy.
3. **By hand.** Pull the new image, run the migrations, restart.

Take a database backup before any update. A city that wants to review changes first should follow a fork and merge releases when it is ready. Migrations in this project only add things and never delete customer data, but a backup is still the rule.
