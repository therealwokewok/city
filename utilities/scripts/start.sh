#!/bin/sh
# Optional start-up: run migrations first when asked, then drop the database owner's credentials
# before the web server starts so the running program only ever holds the limited app role.
set -e
if [ "$RUN_MIGRATIONS_ON_START" = "1" ]; then
  node dist/src/migrate.js
fi
unset OWNER_DATABASE_URL APP_DB_PASSWORD RUN_MIGRATIONS_ON_START
exec node dist/src/main.js
