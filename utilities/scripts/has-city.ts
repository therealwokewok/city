// Prints how many cities the database holds (0 on a fresh install). Used by start.sh to decide whether the
// setup page still needs the owner connection to create the first city.
import pg from 'pg';
const url = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.log('0'); process.exit(0); }
const c = new pg.Client({ connectionString: url });
try { await c.connect(); console.log(String((await c.query('select count(*)::int as n from cities')).rows[0].n)); }
catch { console.log('0'); }
finally { await c.end().catch(() => {}); }
