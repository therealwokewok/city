#!/bin/sh
# Start-up: run migrations first when asked, then drop the database owner's credentials before the web server
# starts, so the running program only ever holds the limited app role. The one exception is a brand new
# database with no city yet: the owner connection is kept for that first run so the setup page can create the
# city, and is dropped at the next start.
set -e
if [ "$RUN_MIGRATIONS_ON_START" = "1" ]; then
  node dist/src/migrate.js
fi
CITIES=$(node dist/scripts/has-city.js 2>/dev/null || echo 0)
if [ "$CITIES" = "0" ] && [ -n "$OWNER_DATABASE_URL" ]; then
  echo "No city yet: the setup page will create it. Open the site and type the setup code printed below."
else
  unset OWNER_DATABASE_URL
fi
unset APP_DB_PASSWORD RUN_MIGRATIONS_ON_START
exec node dist/src/main.js
